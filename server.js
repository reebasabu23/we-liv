require('dotenv').config();
const express = require('express');
const jsonServer = require('json-server');
const ws = require('ws');
const http = require('http');
const path = require('path');

const server = express();
const router = jsonServer.router(path.join(__dirname, 'db.json'));

// Function to load remote database or fallback to local db.json
async function initDatabase() {
  const binId = process.env.JSONBIN_BIN_ID;
  const apiKey = process.env.JSONBIN_API_KEY;

  if (binId && apiKey && binId !== 'YOUR_BIN_ID_HERE') {
    console.log("Fetching database from JSONBin...");
    try {
      const response = await fetch(`https://api.jsonbin.io/v3/b/${binId}?meta=false`, {
        headers: {
          'X-Master-Key': apiKey
        }
      });
      if (response.ok) {
        const data = await response.json();
        router.db.setState(data);
        console.log("Successfully loaded remote database from JSONBin!");
      } else {
        const errorText = await response.text();
        console.error("Failed to load remote database, using local db.json fallback. Error:", errorText);
      }
    } catch (err) {
      console.error("Error connecting to JSONBin, using local db.json fallback:", err.message);
    }
  } else {
    console.log("JSONBin credentials missing or placeholders. Using local db.json.");
  }
}

// Global promise to track active database sync operations
let activeSyncPromise = Promise.resolve();

// Promise to track database load on startup
let dbInitPromise = initDatabase();

// Middleware to block requests until database initialization is complete.
// This is critical for serverless environments (like Vercel) to prevent requests from being processed before the remote data loads.
server.use(async (req, res, next) => {
  try {
    await dbInitPromise;
  } catch (err) {
    console.error("Database initialization failed, proceeding with local fallback:", err.message);
  }
  next();
});

// Middleware to delay sending the response until any active remote DB sync completes.
// This is critical for serverless environments (like Vercel) where background execution is frozen once the response is sent.
server.use((req, res, next) => {
  const originalSend = res.send;
  res.send = function (body) {
    activeSyncPromise
      .catch(() => {}) // Ignore sync errors so the API request itself doesn't hang or crash
      .finally(() => {
        originalSend.call(this, body);
      });
  };
  next();
});

// Override db.write globally to prevent crashes on read-only environments like Vercel
const originalWrite = router.db.write;
router.db.write = function () {
  try {
    originalWrite.call(router.db);
  } catch (err) {
    console.warn("Database file write skipped (running on a read-only filesystem like Vercel):", err.message);
  }

  // Sync to JSONBin
  const binId = process.env.JSONBIN_BIN_ID;
  const apiKey = process.env.JSONBIN_API_KEY;
  console.log(`[Sync Debug] binId exists: ${!!binId}, apiKey exists: ${!!apiKey}, isPlaceholder: ${binId === 'YOUR_BIN_ID_HERE'}`);
  if (binId && apiKey && binId !== 'YOUR_BIN_ID_HERE') {
    const dbState = router.db.getState();
    console.log(`[Sync Debug] Users count in getState(): ${dbState.users ? dbState.users.length : 'undefined'}`);
    console.log(`[Sync Debug] Last user in getState(): ${dbState.users && dbState.users.length ? JSON.stringify(dbState.users[dbState.users.length - 1]) : 'none'}`);
    console.log(`[Sync Debug] Starting remote PUT request to JSONBin...`);
    activeSyncPromise = fetch(`https://api.jsonbin.io/v3/b/${binId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': apiKey
      },
      body: JSON.stringify(dbState)
    })
    .then(response => {
      console.log(`[Sync Debug] PUT request finished with HTTP Status: ${response.status}`);
      if (response.ok) {
        console.log("Successfully synced database to remote JSONBin!");
      } else {
        return response.text().then(errorText => {
          console.error("Failed to sync database to remote JSONBin. Error:", errorText);
        });
      }
    })
    .catch(err => {
      console.error("Error syncing database to remote JSONBin:", err.message);
    });
  }
};


const middlewares = jsonServer.defaults();

server.use(express.json());
server.use(middlewares);

// Sync custom IDs to 'id' for json-server routing compatibility
server.use((req, res, next) => {
  const db = router.db.value();
  if (db.users) {
    db.users.forEach(u => {
      if (u.userId !== undefined) u.id = u.userId;
    });
  }
  if (db.properties) {
    db.properties.forEach(p => {
      if (p.propertyId !== undefined) p.id = p.propertyId;
    });
  }
  if (db.interestRequests) {
    db.interestRequests.forEach(r => {
      if (r.interestRequestId !== undefined) r.id = r.interestRequestId;
    });
  }
  if (db.chatMessages) {
    db.chatMessages.forEach((m, index) => {
      if (m.id === undefined) m.id = index + 1;
    });
  }
  next();
});

// Middleware to log requests
server.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// Secure endpoint to check if environment variables are active on Vercel
server.get('/debug-env', (req, res) => {
  res.json({
    JSONBIN_BIN_ID_exists: !!process.env.JSONBIN_BIN_ID,
    JSONBIN_BIN_ID_value: process.env.JSONBIN_BIN_ID || null,
    JSONBIN_API_KEY_exists: !!process.env.JSONBIN_API_KEY,
    JSONBIN_API_KEY_value: process.env.JSONBIN_API_KEY ? process.env.JSONBIN_API_KEY.substring(0, 8) + '...' : null
  });
});

// Safe database write function for read-only filesystems (e.g., Vercel)
const safeWrite = () => {
  router.db.write();
};

// POST /users/signup (or /signup alias)
server.post(['/users/signup', '/signup'], (req, res) => {
  const { userDto, roomSeekerDto, roomOwnerDto, userRole } = req.body;

  if (!userDto) {
    return res.status(400).json({ message: "Invalid request payload" });
  }

  // Get current users from lowdb
  const users = router.db.get('users').value() || [];
  const maxUserId = users.reduce((max, u) => u.userId > max ? u.userId : max, 0);
  const newUserId = maxUserId > 0 ? maxUserId + 1 : 100;

  // Create new user object
  const newUser = {
    userId: newUserId,
    firstName: userDto.firstName,
    lastName: userDto.lastName,
    email: userDto.email,
    password: userDto.password,
    gender: userDto.gender,
    dateOfBirth: userDto.dateOfBirth,
    phone: userDto.phone,
    profilePictureURL: userDto.profilePictureURL,
    userRole: userRole
  };

  if (userRole === 'ROOM_SEEKER' && roomSeekerDto) {
    Object.assign(newUser, {
      bio: roomSeekerDto.bio,
      postCode: roomSeekerDto.postCode,
      budget: roomSeekerDto.budget,
      occupation: roomSeekerDto.occupation,
      roomTypePreference: roomSeekerDto.roomTypePreference,
      furniturePreference: roomSeekerDto.furniturePreference,
      smokingPreference: roomSeekerDto.smokingPreference,
      petPreference: roomSeekerDto.petPreference,
      genderPreference: roomSeekerDto.genderPreference,
      socialPreference: roomSeekerDto.socialPreference,
      userInterestsDtos: roomSeekerDto.userInterestsDtos,
      userSocialLinksDtos: roomSeekerDto.userSocialLinksDtos
    });
  } else if (userRole === 'ROOM_OWNER' && roomOwnerDto) {
    Object.assign(newUser, {
      bio: roomOwnerDto.bio,
      noOfProperties: roomOwnerDto.noOfProperties,
      userSocialLinksDtos: roomOwnerDto.userSocialLinksDtos
    });

    // Save properties submitted during owner signup
    if (roomOwnerDto.propertyDto && Array.isArray(roomOwnerDto.propertyDto)) {
      const properties = router.db.get('properties').value() || [];
      let maxPropId = properties.reduce((max, p) => p.propertyId > max ? p.propertyId : max, 0);
      
      roomOwnerDto.propertyDto.forEach(prop => {
        maxPropId += 1;
        const newProperty = {
          ...prop,
          propertyId: maxPropId,
          ownerId: newUserId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        router.db.get('properties').push(newProperty);
        safeWrite();
      });
    }
  }

  // Persist user
  router.db.get('users').push(newUser);
  safeWrite();

  // Generate Response
  const responseUserDto = {
    userId: newUserId,
    firstName: newUser.firstName,
    lastName: newUser.lastName,
    email: newUser.email,
    password: null,
    gender: newUser.gender,
    dateOfBirth: newUser.dateOfBirth,
    phone: newUser.phone,
    profilePictureURL: null
  };

  const dummyToken = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJyb29uaUBleGFtcGxlLmNvbSIsImlhdCI6MTc4MDI2NzM4Mn0.SpXwye3M0VGC6l52u_mgbAEGFmXSOcm-5STyGYan2JA";

  if (userRole === 'ROOM_SEEKER') {
    const allProperties = router.db.get('properties').value() || [];
    res.status(201).json({
      token: dummyToken,
      message: "Successfully created user",
      userDto: responseUserDto,
      propertyDtos: allProperties,
      roomSeekerDtos: []
    });
  } else {
    // Return all room seekers in database
    const allSeekers = (router.db.get('users').value() || [])
      .filter(u => u.userRole === 'ROOM_SEEKER')
      .map(u => ({
        name: `${u.firstName} ${u.lastName}`,
        bio: u.bio || "",
        postCode: u.postCode || null,
        location: null,
        budget: u.budget || null,
        occupation: u.occupation || "",
        roomTypePreference: u.roomTypePreference || "",
        furniturePreference: u.furniturePreference || "",
        smokingPreference: u.smokingPreference || "",
        petPreference: u.petPreference || "",
        genderPreference: u.genderPreference || "",
        socialPreference: u.socialPreference || "",
        userInterestsDtos: u.userInterestsDtos || null,
        userSocialLinksDtos: u.userSocialLinksDtos || null
      }));

    res.status(201).json({
      token: dummyToken,
      message: "Successfully created user",
      userDto: responseUserDto,
      propertyDtos: [],
      roomSeekerDtos: allSeekers
    });
  }
});

// POST /users/login
server.post(['/users/login', '/login'], (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required" });
  }

  // Find user by email and password
  const user = router.db.get('users').find({ email, password }).value();

  if (!user) {
    return res.status(401).json({ message: "Invalid email or password" });
  }

  // Generate Response DTO
  const responseUserDto = {
    userId: user.userId,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    password: null,
    gender: user.gender,
    dateOfBirth: user.dateOfBirth,
    phone: user.phone,
    profilePictureURL: user.profilePictureURL || null
  };

  const dummyToken = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJyb29uaUBleGFtcGxlLmNvbSIsImlhdCI6MTc4MDI2NzM4Mn0.SpXwye3M0VGC6l52u_mgbAEGFmXSOcm-5STyGYan2JA";

  if (user.userRole === 'ROOM_SEEKER') {
    const allProperties = router.db.get('properties').value() || [];
    res.status(200).json({
      token: dummyToken,
      message: "Successfully logged in",
      userDto: responseUserDto,
      propertyDtos: allProperties,
      roomSeekerDtos: []
    });
  } else {
    // Return all room seekers in database
    const allSeekers = (router.db.get('users').value() || [])
      .filter(u => u.userRole === 'ROOM_SEEKER')
      .map(u => ({
        name: `${u.firstName} ${u.lastName}`,
        bio: u.bio || "",
        postCode: u.postCode || null,
        location: null,
        budget: u.budget || null,
        occupation: u.occupation || "",
        roomTypePreference: u.roomTypePreference || "",
        furniturePreference: u.furniturePreference || "",
        smokingPreference: u.smokingPreference || "",
        petPreference: u.petPreference || "",
        genderPreference: u.genderPreference || "",
        socialPreference: u.socialPreference || "",
        userInterestsDtos: u.userInterestsDtos || null,
        userSocialLinksDtos: u.userSocialLinksDtos || null
      }));

    res.status(200).json({
      token: dummyToken,
      message: "Successfully logged in",
      userDto: responseUserDto,
      propertyDtos: [],
      roomSeekerDtos: allSeekers
    });
  }
});

// GET /property/filter/by/values
server.get('/property/filter/by/values', (req, res) => {
  let properties = router.db.get('properties').value() || [];
  const { postCode, minRent, maxRent, minRooms, maxRooms, radius } = req.query;

  if (postCode && postCode !== 'all' && radius !== 'all') {
    properties = properties.filter(p => 
      p.postcode && p.postcode.toLowerCase().replace(/\s/g, '') === postCode.toLowerCase().replace(/\s/g, '')
    );
  }

  if (minRent && minRent !== 'all') {
    properties = properties.filter(p => p.rent >= parseFloat(minRent));
  }

  if (maxRent && maxRent !== 'all') {
    properties = properties.filter(p => p.rent <= parseFloat(maxRent));
  }

  res.json(properties);
});

// GET /property/view/:id
server.get('/property/view/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const property = router.db.get('properties').find({ propertyId: id }).value();

  if (!property) {
    return res.status(404).json({ message: "Property not found" });
  }

  // To support exact format of PDF return, if propertyId or ownerId is null we mock it, 
  // but let's return the real properties fields so it's a functioning database.
  res.json(property);
});

// POST /interest/request/create
server.post('/interest/request/create', (req, res) => {
  const { seekerUserId, ownerUserId, propertyId, message, initiator, status } = req.body;

  const requests = router.db.get('interestRequests').value() || [];
  const maxReqId = requests.reduce((max, r) => r.interestRequestId > max ? r.interestRequestId : max, 0);
  const newReqId = maxReqId + 1;

  const newRequest = {
    interestRequestId: newReqId,
    seekerUserId: parseInt(seekerUserId),
    ownerUserId: parseInt(ownerUserId),
    propertyId: parseInt(propertyId),
    message: message,
    initiator: parseInt(initiator),
    status: status || 'PENDING'
  };

  router.db.get('interestRequests').push(newRequest);
  safeWrite();
  res.status(201).json(newRequest);
});

// GET /interest/request/room/seeker/get/incoming/:userId
server.get('/interest/request/room/seeker/get/incoming/:userId', (req, res) => {
  const userId = parseInt(req.params.userId);
  const requests = router.db.get('interestRequests').value() || [];
  
  // Incoming requests to room seeker are those where seekerUserId is this user, and they are NOT the initiator
  const incoming = requests.filter(r => r.seekerUserId === userId && r.initiator !== userId);

  const response = incoming.map(r => {
    const owner = router.db.get('users').find({ userId: r.ownerUserId }).value() || {};
    const property = router.db.get('properties').find({ propertyId: r.propertyId }).value() || {};

    return {
      userId: owner.userId || r.ownerUserId,
      firstName: owner.firstName || "Unknown",
      lastName: owner.lastName || "User",
      message: r.message,
      propertyId: r.propertyId,
      title: property.title || "Spacious Double Room in Modern Flat",
      address: property.address || "12 Baker Street, London",
      status: r.status
    };
  });

  res.json(response);
});

// GET /interest/request/room/seeker/get/outgoing/:userId
server.get('/interest/request/room/seeker/get/outgoing/:userId', (req, res) => {
  const userId = parseInt(req.params.userId);
  const requests = router.db.get('interestRequests').value() || [];
  
  // Outgoing requests from room seeker are those where seekerUserId is this user, and they ARE the initiator
  const outgoing = requests.filter(r => r.seekerUserId === userId && r.initiator === userId);

  const response = outgoing.map(r => {
    const owner = router.db.get('users').find({ userId: r.ownerUserId }).value() || {};
    const property = router.db.get('properties').find({ propertyId: r.propertyId }).value() || {};

    return {
      userId: owner.userId || r.ownerUserId,
      firstName: owner.firstName || "Unknown",
      lastName: owner.lastName || "User",
      message: r.message,
      propertyId: r.propertyId,
      title: property.title || "Spacious Double Room in Modern Flat",
      address: property.address || "12 Baker Street, London",
      status: r.status
    };
  });

  res.json(response);
});

// GET /chat/matches/:matchId/messages
server.get('/chat/matches/:matchId/messages', (req, res) => {
  const matchId = parseInt(req.params.matchId);
  const messages = router.db.get('chatMessages').value() || [];
  
  const matchMessages = messages
    .filter(m => m.matchId === matchId)
    .sort((a, b) => b.sequence - a.sequence); // Sort by sequence descending matching the document

  res.json(matchMessages);
});

// Fallback to json-server router for other resources
server.use(router);

const PORT = 8080;
const httpServer = http.createServer(server);

// Create WebSocket server for ws://localhost:8080/ws/chat
const wsServer = new ws.Server({ noServer: true });

wsServer.on('connection', (socket) => {
  console.log('WebSocket connection established.');

  socket.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'message:new') {
        const matchId = parseInt(data.matchId);
        const clientId = data.clientId;
        const body = data.body;

        // Resolve a sender ID based on clientId mapping
        let senderId = 4;
        if (clientId === 'c102') {
          senderId = 17;
        } else if (clientId && clientId.startsWith('u')) {
          senderId = parseInt(clientId.substring(1));
        }

        // Calculate sequence
        const messages = router.db.get('chatMessages').value() || [];
        const matchMsgs = messages.filter(m => m.matchId === matchId);
        const nextSequence = matchMsgs.reduce((max, m) => m.sequence > max ? m.sequence : max, 0) + 1;

        const newMessage = {
          type: 'message:deliver',
          matchId: matchId,
          senderId: senderId,
          body: body,
          sequence: nextSequence,
          createdAtEpochMs: Date.now()
        };

        // Save to db.json
        router.db.get('chatMessages').push(newMessage);
        safeWrite();

        // Broadcast to all connected clients
        const payload = JSON.stringify(newMessage);
        wsServer.clients.forEach((client) => {
          if (client.readyState === ws.OPEN) {
            client.send(payload);
          }
        });
      }
    } catch (e) {
      console.error('Error handling WebSocket message:', e);
    }
  });
});

// Delegate Upgrade to wsServer
httpServer.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === '/ws/chat') {
    wsServer.handleUpgrade(request, socket, head, (wsConn) => {
      wsServer.emit('connection', wsConn, request);
    });
  } else {
    socket.destroy();
  }
});

// Initialize database first then start server
async function start() {
  await initDatabase();
  httpServer.listen(PORT, () => {
    console.log(`WeLiv mock backend is running on http://localhost:${PORT}`);
  });
}
start();
// this will work