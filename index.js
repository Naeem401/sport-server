require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingInterval: 25000,
  pingTimeout: 5000
});

// Middleware
app.use(cors());
app.use(express.json());

// API Configuration
const API_BASE_URL = 'https://sport-highlights-api.p.rapidapi.com';
const API_KEY = process.env.API_KEY || '9039004ce3msh8ae4f9c049e7c1fp13969fjsn90e3ab56524a';

const UPDATE_INTERVAL = 60000; // 1 minute updates for active matches
const CACHE_TTL = 30000; // 30 seconds cache
const INACTIVITY_TIMEOUT = 300000; // 5 minutes inactivity timeout

// Supported sports
const SPORTS = {
  football: 'football',
  cricket: 'cricket',
  basketball: 'basketball',
  hockey: 'hockey',
  baseball: 'baseball',
  rugby: 'rugby',
  handball: 'handball',
  volleyball: 'volleyball'
};

// Data Structures
const matchesCache = new Map();
const matchDetailsCache = new Map();
const activeSubscriptions = {};
const activeMatchSubscriptions = {};

// Initialize subscriptions only for matches
Object.keys(SPORTS).forEach(sport => {
  activeSubscriptions[sport] = {
    users: new Set(),
    interval: null,
    lastUpdated: null,
    isActive: false
  };
  activeMatchSubscriptions[sport] = {};
});

// Fetch match details with caching
async function fetchMatchDetails(sport, matchId) {
  const cacheKey = `${sport}-${matchId}`;
  
  if (matchDetailsCache.has(cacheKey)) {
    const cached = matchDetailsCache.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }
  }

  try {
    const response = await axios.get(`${API_BASE_URL}/${SPORTS[sport]}/matches/${matchId}`, {
      headers: {
        'x-rapidapi-key': API_KEY,
        'x-rapidapi-host': 'sport-highlights-api.p.rapidapi.com'
      },
      timeout: 5000
    });

    const data = response.data;
    matchDetailsCache.set(cacheKey, {
      data: data,
      timestamp: Date.now()
    });
    
    return data;
  } catch (error) {
    console.error(`Error fetching ${sport} match details:`, error.message);
    
    if (matchDetailsCache.has(cacheKey)) {
      console.log(`Returning cached data for ${sport} match ${matchId}`);
      return matchDetailsCache.get(cacheKey).data;
    }
    
    return null;
  }
}

// Fetch matches with caching (only for active subscriptions)
async function fetchMatches(sport, params = {}, retries = 3) {
  const { date, timezone = 'UTC', limit = 100 } = params;
  const cacheKey = `${sport}:${date}:${timezone}:${limit}`;

  if (matchesCache.has(cacheKey)) {
    const cached = matchesCache.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }
  }

  try {
    const response = await axios.get(`${API_BASE_URL}/${SPORTS[sport]}/matches`, {
      headers: {
        'x-rapidapi-key': API_KEY,
        'x-rapidapi-host': 'sport-highlights-api.p.rapidapi.com'
      },
      params: {
        date,
        timezone,
        limit
      },
      timeout: 10000
    });

    const data = response.data || [];
    matchesCache.set(cacheKey, {
      data: data,
      timestamp: Date.now()
    });
    
    return data;
  } catch (error) {
    console.error(`Error fetching ${sport} matches (attempt ${4-retries}):`, error.message);
    
    if (matchesCache.has(cacheKey)) {
      console.log(`Returning cached data for ${sport} matches`);
      return matchesCache.get(cacheKey).data;
    }
    
    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return fetchMatches(sport, params, retries - 1);
    }
    
    throw error;
  }
}

// Optimized match updates for active subscriptions only
function startMatchUpdates(sport) {
  if (activeSubscriptions[sport].interval) {
    activeSubscriptions[sport].isActive = true;
    return;
  }

  const updateMatches = async () => {
    if (activeSubscriptions[sport].users.size > 0) {
      try {
        const today = new Date().toISOString().split('T')[0];
        const matches = await fetchMatches(sport, { date: today });
        
        const subscribedMatches = Object.keys(activeMatchSubscriptions[sport]);
        const relevantMatches = matches.filter(match => 
          subscribedMatches.includes(match.id)
        );
        
        const matchUpdatePromises = relevantMatches.map(async match => {
          const details = await fetchMatchDetails(sport, match.id);
          if (details) {
            io.to(`${sport}-${match.id}`).emit('match-update', {
              sport,
              matchId: match.id,
              data: details,
              lastUpdated: new Date().toISOString()
            });
          }
        });

        await Promise.all(matchUpdatePromises);

        if (activeSubscriptions[sport].users.size > 0) {
          io.to(sport).emit('matches-update', {
            sport,
            data: matches,
            lastUpdated: new Date().toISOString()
          });
        }
        
        activeSubscriptions[sport].lastUpdated = Date.now();
      } catch (error) {
        console.error(`Failed to update ${sport} matches:`, error.message);
      }
    } else {
      if (activeSubscriptions[sport].interval) {
        clearInterval(activeSubscriptions[sport].interval);
        activeSubscriptions[sport].interval = null;
        activeSubscriptions[sport].isActive = false;
        console.log(`Stopped ${sport} updates - no active users`);
      }
    }
  };

  activeSubscriptions[sport].isActive = true;
  updateMatches();
  activeSubscriptions[sport].interval = setInterval(updateMatches, UPDATE_INTERVAL);
  console.log(`Started ${sport} match updates (1 minute interval)`);
}

// Cleanup inactive subscriptions
function cleanupInactiveSubscriptions() {
  const now = Date.now();
  Object.keys(SPORTS).forEach(sport => {
    if (activeSubscriptions[sport].users.size === 0 && 
        (now - activeSubscriptions[sport].lastUpdated) > INACTIVITY_TIMEOUT) {
      activeSubscriptions[sport].isActive = false;
    }
    
    Object.keys(activeMatchSubscriptions[sport]).forEach(matchId => {
      if (activeMatchSubscriptions[sport][matchId].size === 0) {
        delete activeMatchSubscriptions[sport][matchId];
      }
    });
  });
}

setInterval(cleanupInactiveSubscriptions, 60000);

// Socket.io for real-time matches only
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Subscribe to sport matches (real-time)
  socket.on('subscribe-matches', (sport) => {
    if (!SPORTS[sport]) {
      return socket.emit('error', { message: 'Invalid sport specified' });
    }

    socket.join(sport);
    activeSubscriptions[sport].users.add(socket.id);
    
    if (!activeSubscriptions[sport].isActive) {
      startMatchUpdates(sport);
    }

    const today = new Date().toISOString().split('T')[0];
    const cacheKey = `${sport}:${today}:UTC:100`;
    if (matchesCache.has(cacheKey)) {
      const cached = matchesCache.get(cacheKey);
      socket.emit('matches-update', {
        sport,
        data: cached.data,
        lastUpdated: new Date(cached.timestamp).toISOString()
      });
    }

    console.log(`Client ${socket.id} subscribed to real-time ${sport} matches`);
  });

  // Subscribe to specific match (real-time)
  socket.on('subscribe-match', ({ sport, matchId }) => {
    if (!SPORTS[sport]) {
      return socket.emit('error', { message: 'Invalid sport specified' });
    }

    const roomName = `${sport}-${matchId}`;
    socket.join(roomName);
    
    if (!activeMatchSubscriptions[sport][matchId]) {
      activeMatchSubscriptions[sport][matchId] = new Set();
    }
    activeMatchSubscriptions[sport][matchId].add(socket.id);

    const cacheKey = `${sport}-${matchId}`;
    if (matchDetailsCache.has(cacheKey)) {
      const cached = matchDetailsCache.get(cacheKey);
      socket.emit('match-update', {
        sport,
        matchId,
        data: cached.data,
        lastUpdated: new Date(cached.timestamp).toISOString()
      });
    } else {
      fetchMatchDetails(sport, matchId).then(details => {
        if (details) {
          socket.emit('match-update', {
            sport,
            matchId,
            data: details,
            lastUpdated: new Date().toISOString()
          });
        }
      });
    }

    console.log(`Client ${socket.id} subscribed to real-time ${sport} match ${matchId}`);
  });

  // Unsubscribe from sport matches
  socket.on('unsubscribe-matches', (sport) => {
    if (!SPORTS[sport]) return;
    
    socket.leave(sport);
    activeSubscriptions[sport].users.delete(socket.id);
    
    if (activeSubscriptions[sport].users.size === 0) {
      activeSubscriptions[sport].lastUpdated = Date.now();
      activeSubscriptions[sport].isActive = false;
    }
  });

  // Unsubscribe from specific match
  socket.on('unsubscribe-match', ({ sport, matchId }) => {
    if (!SPORTS[sport] || !activeMatchSubscriptions[sport][matchId]) return;
    
    socket.leave(`${sport}-${matchId}`);
    activeMatchSubscriptions[sport][matchId].delete(socket.id);
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    Object.keys(SPORTS).forEach(sport => {
      if (activeSubscriptions[sport].users.has(socket.id)) {
        activeSubscriptions[sport].users.delete(socket.id);
        
        if (activeSubscriptions[sport].users.size === 0) {
          activeSubscriptions[sport].lastUpdated = Date.now();
          activeSubscriptions[sport].isActive = false;
        }
      }
      
      Object.keys(activeMatchSubscriptions[sport]).forEach(matchId => {
        if (activeMatchSubscriptions[sport][matchId].has(socket.id)) {
          activeMatchSubscriptions[sport][matchId].delete(socket.id);
        }
      });
    });
  });
});

// REST API Endpoints (non-real-time)
Object.keys(SPORTS).forEach(sport => {
  // Matches endpoint (can be called directly or via socket)
  app.get(`/api/${sport}/matches`, async (req, res) => {
    try {
      const { date, timezone = 'UTC', limit = 100 } = req.query;
      
      if (!date) {
        return res.status(400).json({
          success: false,
          error: 'Date parameter is required'
        });
      }

      const data = await fetchMatches(sport, { date, timezone, limit });
      
      res.json({
        success: true,
        sport,
        data,
        lastUpdated: new Date().toISOString()
      });
    } catch (error) {
      console.error(`Error fetching ${sport} matches:`, error.message);
      res.status(500).json({
        success: false,
        sport,
        error: `Failed to fetch ${sport} matches`,
        details: error.message
      });
    }
  });

  // Match details endpoint (can be called directly or via socket)
  app.get(`/api/${sport}/matches/:id`, async (req, res) => {
    try {
      const { id } = req.params;
      const details = await fetchMatchDetails(sport, id);

      if (details) {
        res.json({
          success: true,
          sport,
          data: details,
          lastUpdated: new Date().toISOString()
        });
      } else {
        res.status(404).json({
          success: false,
          sport,
          error: 'Match details not found'
        });
      }
    } catch (error) {
      console.error(`Error fetching ${sport} match details:`, error.message);
      res.status(500).json({
        success: false,
        sport,
        error: `Failed to fetch ${sport} match details`
      });
    }
  });

  // Other endpoints (normal API calls, no real-time)
  app.get(`/api/${sport}/highlights`, async (req, res) => {
    try {
      const { countryName, date, matchId, limit = 20 } = req.query;
      const params = { limit: Math.min(limit, 40) };

      if (countryName) params.countryName = countryName;
      if (date) params.date = date;
      if (matchId) params.matchId = matchId;

      if (!countryName && !date && !matchId) {
        return res.status(400).json({
          success: false,
          error: 'At least one parameter is required'
        });
      }

      const response = await axios.get(`${API_BASE_URL}/${SPORTS[sport]}/highlights`, {
        headers: {
          'x-rapidapi-key': API_KEY,
          'x-rapidapi-host': 'sport-highlights-api.p.rapidapi.com'
        },
        params,
        timeout: 5000
      });

      res.json({
        success: true,
        sport,
        data: response.data
      });
    } catch (error) {
      console.error(`Error fetching ${sport} highlights:`, error.message);
      res.status(500).json({
        success: false,
        sport,
        error: `Failed to fetch ${sport} highlights`
      });
    }
  });

  app.get(`/api/${sport}/standings`, async (req, res) => {
    try {
      const { leagueId, season } = req.query;
      
      if (!leagueId || !season) {
        return res.status(400).json({
          success: false,
          error: 'Both leagueId and season are required'
        });
      }

      const response = await axios.get(`${API_BASE_URL}/${SPORTS[sport]}/standings`, {
        headers: {
          'x-rapidapi-key': API_KEY,
          'x-rapidapi-host': 'sport-highlights-api.p.rapidapi.com'
        },
        params: { leagueId, season },
        timeout: 5000
      });

      res.json({
        success: true,
        sport,
        data: response.data
      });
    } catch (error) {
      console.error(`Error fetching ${sport} standings:`, error.message);
      res.status(500).json({
        success: false,
        sport,
        error: `Failed to fetch ${sport} standings`
      });
    }
  });

  app.get(`/api/${sport}/h2h`, async (req, res) => {
    try {
      const { teamIdOne, teamIdTwo } = req.query;
      
      if (!teamIdOne || !teamIdTwo) {
        return res.status(400).json({
          success: false,
          error: 'Both teamIdOne and teamIdTwo are required'
        });
      }

      const response = await axios.get(`${API_BASE_URL}/${SPORTS[sport]}/matches/head-to-head`, {
        headers: {
          'x-rapidapi-key': API_KEY,
          'x-rapidapi-host': 'sport-highlights-api.p.rapidapi.com'
        },
        params: { teamIdOne, teamIdTwo },
        timeout: 5000
      });

      res.json({
        success: true,
        sport,
        data: response.data
      });
    } catch (error) {
      console.error(`Error fetching ${sport} H2H:`, error.message);
      res.status(500).json({
        success: false,
        sport,
        error: `Failed to fetch ${sport} head-to-head`
      });
    }
  });

  app.get(`/api/${sport}/last5`, async (req, res) => {
    try {
      const { teamId } = req.query;
      
      if (!teamId) {
        return res.status(400).json({
          success: false,
          error: 'teamId is required'
        });
      }

      const response = await axios.get(`${API_BASE_URL}/${SPORTS[sport]}/matches/last5`, {
        headers: {
          'x-rapidapi-key': API_KEY,
          'x-rapidapi-host': 'sport-highlights-api.p.rapidapi.com'
        },
        params: { teamId },
        timeout: 5000
      });

      res.json({
        success: true,
        sport,
        data: response.data
      });
    } catch (error) {
      console.error(`Error fetching ${sport} last 5 games:`, error.message);
      res.status(500).json({
        success: false,
        sport,
        error: `Failed to fetch ${sport} last 5 games`
      });
    }
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.send(`
    <h1>Sports Live Score API</h1>
    <p>Real-time matches updates every ${UPDATE_INTERVAL/1000} seconds for active subscriptions</p>
    <h2>Supported Sports</h2>
    <ul>
      ${Object.keys(SPORTS).map(sport => `
        <li>
          <strong>${sport}</strong>
          <ul>
            <li>WebSocket: subscribe-matches/${sport} (real-time)</li>
            <li>GET /api/${sport}/matches?date=YYYY-MM-DD&timezone=Timezone</li>
            <li>GET /api/${sport}/matches/:id</li>
            <li>GET /api/${sport}/highlights (normal API)</li>
            <li>GET /api/${sport}/standings (normal API)</li>
            <li>GET /api/${sport}/h2h (normal API)</li>
            <li>GET /api/${sport}/last5 (normal API)</li>
          </ul>
        </li>
      `).join('')}
    </ul>
  `);
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT} (for real-time matches only)`);
  console.log(`HTTP: http://localhost:${PORT}`);
});