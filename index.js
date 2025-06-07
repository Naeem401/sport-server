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
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// API Configuration
const API_BASE_URL = 'https://sport-highlights-api.p.rapidapi.com';
// const API_KEY = '9039004ce3msh8ae4f9c049e7c1fp13969fjsn90e3ab56524a';
// const API_KEY = 'e8555e69a8msh1de65d7c1cbf7d1p1bd3b7jsn2efec15ed0d5';
const API_KEY = '23ed8f1637msh9d5ecb868166523p1db1adjsnab581199d3d5';
const UPDATE_INTERVAL = 3600000; // 1 hour
const CACHE_TTL = 1800000; // 30 minutes cache

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

// Initialize subscriptions
Object.keys(SPORTS).forEach(sport => {
  activeSubscriptions[sport] = {
    users: new Set(),
    interval: null,
    lastUpdated: null
  };
  activeMatchSubscriptions[sport] = {};
});

// Fetch match details
async function fetchMatchDetails(sport, matchId) {
  try {
    const response = await axios.get(`${API_BASE_URL}/${SPORTS[sport]}/matches/${matchId}`, {
      headers: {
        'x-rapidapi-key': API_KEY,
        'x-rapidapi-host': 'sport-highlights-api.p.rapidapi.com'
      }
    });
    return response.data;
  } catch (error) {
    console.error(`Error fetching ${sport} match details:`, error.message);
    return null;
  }
}

// Fetch matches with details
async function fetchMatches(sport, params = {}) {
  try {
    const queryParams = { limit: 100 };
    
    if (params.date) {
      queryParams.date = params.date;
    } else if (params.leagueId) {
      queryParams.leagueId = params.leagueId;
    } else {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(endDate.getDate() - 3);
      queryParams.dateFrom = startDate.toISOString().split('T')[0];
      queryParams.dateTo = endDate.toISOString().split('T')[0];
    }

    if (params.teamId) queryParams.teamId = params.teamId;

    const response = await axios.get(`${API_BASE_URL}/${SPORTS[sport]}/matches`, {
      headers: {
        'x-rapidapi-key': API_KEY,
        'x-rapidapi-host': 'sport-highlights-api.p.rapidapi.com'
      },
      params: queryParams
    });

    const matches = response.data || [];
    const cacheKey = `${sport}:${JSON.stringify(queryParams)}`;
    
    matchesCache.set(cacheKey, {
      data: matches,
      timestamp: Date.now()
    });
    
    return matches;
  } catch (error) {
    console.error(`Error fetching ${sport} matches:`, error.message);
    throw error;
  }
}

// Start/stop match updates
function startMatchUpdates(sport) {
  if (activeSubscriptions[sport].interval) return;

  const updateMatches = async () => {
    try {
      const matches = await fetchMatches(sport);
      
      // Update match details for subscribed matches
      matches.forEach(match => {
        if (activeMatchSubscriptions[sport][match.id]) {
          fetchMatchDetails(sport, match.id).then(details => {
            if (details) {
              matchDetailsCache.set(match.id, {
                data: details,
                timestamp: Date.now()
              });
              io.to(`${sport}-${match.id}`).emit('match-update', {
                sport,
                matchId: match.id,
                data: details,
                lastUpdated: new Date().toISOString()
              });
            }
          });
        }
      });

      io.to(sport).emit('matches-update', {
        sport,
        data: matches,
        lastUpdated: new Date().toISOString()
      });
      activeSubscriptions[sport].lastUpdated = Date.now();
    } catch (error) {
      console.error(`Failed to update ${sport} matches:`, error.message);
    }
  };

  updateMatches();
  activeSubscriptions[sport].interval = setInterval(updateMatches, UPDATE_INTERVAL);
  console.log(`Started ${sport} match updates`);
}

// Cleanup functions
function stopMatchUpdates(sport) {
  if (activeSubscriptions[sport].interval) {
    clearInterval(activeSubscriptions[sport].interval);
    activeSubscriptions[sport].interval = null;
    console.log(`Stopped ${sport} match updates`);
  }
}

setInterval(() => {
  const now = Date.now();
  Object.keys(SPORTS).forEach(sport => {
    if (activeSubscriptions[sport].users.size === 0 && 
        activeSubscriptions[sport].interval && 
        (now - activeSubscriptions[sport].lastUpdated) > 3600000) {
      stopMatchUpdates(sport);
    }
    
    // Cleanup inactive match subscriptions
    Object.keys(activeMatchSubscriptions[sport]).forEach(matchId => {
      if (activeMatchSubscriptions[sport][matchId].size === 0) {
        delete activeMatchSubscriptions[sport][matchId];
      }
    });
  });
}, 60000);

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Subscribe to sport matches
  socket.on('subscribe-matches', (sport) => {
    if (!SPORTS[sport]) {
      return socket.emit('error', { message: 'Invalid sport specified' });
    }

    socket.join(sport);
    activeSubscriptions[sport].users.add(socket.id);
    
    if (activeSubscriptions[sport].users.size === 1) {
      startMatchUpdates(sport);
    }

    const cacheKey = `${sport}:{"limit":100}`;
    if (matchesCache.has(cacheKey)) {
      const cached = matchesCache.get(cacheKey);
      socket.emit('matches-update', {
        sport,
        data: cached.data,
        lastUpdated: new Date(cached.timestamp).toISOString()
      });
    }

    console.log(`Client ${socket.id} subscribed to ${sport} matches`);
  });

  // Subscribe to specific match
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

    if (matchDetailsCache.has(matchId)) {
      const cached = matchDetailsCache.get(matchId);
      socket.emit('match-update', {
        sport,
        matchId,
        data: cached.data,
        lastUpdated: new Date(cached.timestamp).toISOString()
      });
    } else {
      fetchMatchDetails(sport, matchId).then(details => {
        if (details) {
          matchDetailsCache.set(matchId, {
            data: details,
            timestamp: Date.now()
          });
          socket.emit('match-update', {
            sport,
            matchId,
            data: details,
            lastUpdated: new Date().toISOString()
          });
        }
      });
    }

    console.log(`Client ${socket.id} subscribed to ${sport} match ${matchId}`);
  });

  // Unsubscribe handlers
  socket.on('unsubscribe-matches', (sport) => {
    if (!SPORTS[sport]) return;
    socket.leave(sport);
    activeSubscriptions[sport].users.delete(socket.id);
    if (activeSubscriptions[sport].users.size === 0) {
      activeSubscriptions[sport].lastUpdated = Date.now();
    }
  });

  socket.on('unsubscribe-match', ({ sport, matchId }) => {
    if (!SPORTS[sport] || !activeMatchSubscriptions[sport][matchId]) return;
    socket.leave(`${sport}-${matchId}`);
    activeMatchSubscriptions[sport][matchId].delete(socket.id);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    Object.keys(SPORTS).forEach(sport => {
      if (activeSubscriptions[sport].users.has(socket.id)) {
        activeSubscriptions[sport].users.delete(socket.id);
        if (activeSubscriptions[sport].users.size === 0) {
          activeSubscriptions[sport].lastUpdated = Date.now();
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

// REST API Endpoints
Object.keys(SPORTS).forEach(sport => {
  // Matches endpoint
  app.get(`/api/${sport}/matches`, async (req, res) => {
    try {
      const { leagueId, date, teamId, days = '7' } = req.query;
      const params = {};
      
      if (date) params.date = date;
      else if (leagueId) params.leagueId = leagueId;
      else {
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(endDate.getDate() - parseInt(days));
        params.dateFrom = startDate.toISOString().split('T')[0];
        params.dateTo = endDate.toISOString().split('T')[0];
      }

      if (teamId) params.teamId = teamId;

      const data = await fetchMatches(sport, params);
      res.json({
        success: true,
        data,
        lastUpdated: new Date().toISOString(),
        parametersUsed: params
      });
    } catch (error) {
      console.error(`Error fetching ${sport} matches:`, error.message);
      res.status(500).json({
        success: false,
        error: `Failed to fetch ${sport} matches`,
        details: error.response?.data || error.message
      });
    }
  });

  // Match details endpoint
  app.get(`/api/${sport}/matches/:id`, async (req, res) => {
    try {
      const { id } = req.params;
      let details = null;

      if (matchDetailsCache.has(id)) {
        details = matchDetailsCache.get(id).data;
      } else {
        details = await fetchMatchDetails(sport, id);
        if (details) {
          matchDetailsCache.set(id, {
            data: details,
            timestamp: Date.now()
          });
        }
      }

      if (details) {
        res.json({
          success: true,
          data: details,
          lastUpdated: new Date().toISOString()
        });
      } else {
        res.status(404).json({
          success: false,
          error: 'Match details not found'
        });
      }
    } catch (error) {
      console.error(`Error fetching ${sport} match details:`, error.message);
      res.status(500).json({
        success: false,
        error: `Failed to fetch ${sport} match details`,
        details: error.response?.data || error.message
      });
    }
  });
  // Get highlights
  app.get(`/api/${sport}/highlights`, async (req, res) => {
    try {
      const { 
        countryName,
        date,
        matchId,
        limit = 40
      } = req.query;

      // Validate at least one parameter exists
      if (!countryName && !date && !matchId) {
        return res.status(400).json({
          success: false,
          error: 'At least one parameter is required (countryName, date, or matchId)'
        });
      }

      const params = {
        limit: Math.min(limit, 40),
        timezone: 'Etc/UTC'
      };

      // Apply filters
      if (countryName) params.countryName = countryName;
      if (date) params.date = date;
      if (matchId) params.matchId = matchId;

      const response = await axios.get(`${API_BASE_URL}/${SPORTS[sport]}/highlights`, {
        headers: {
          'x-rapidapi-key': API_KEY,
          'x-rapidapi-host': 'sport-highlights-api.p.rapidapi.com'
        },
        params
      });

      res.json({
        success: true,
        data: response.data,
        lastUpdated: new Date().toISOString(),
        parametersUsed: params
      });
    } catch (error) {
      console.error(`Error fetching ${sport} highlights:`, error.message);
      res.status(error.response?.status || 500).json({
        success: false,
        error: `Failed to fetch ${sport} highlights`,
        details: error.response?.data || error.message
      });
    }
  });
  // Standings endpoint
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
        params: { leagueId, season }
      });

      res.json({
        success: true,
        data: response.data,
        lastUpdated: new Date().toISOString()
      });
    } catch (error) {
      console.error(`Error fetching ${sport} standings:`, error.message);
      res.status(500).json({
        success: false,
        error: `Failed to fetch ${sport} standings`,
        details: error.response?.data || error.message
      });
    }
  });

  // Head-to-head endpoint
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
        params: { teamIdOne, teamIdTwo }
      });

      res.json({
        success: true,
        data: response.data,
        lastUpdated: new Date().toISOString()
      });
    } catch (error) {
      console.error(`Error fetching ${sport} H2H:`, error.message);
      res.status(500).json({
        success: false,
        error: `Failed to fetch ${sport} head-to-head`,
        details: error.response?.data || error.message
      });
    }
  });

  // Last 5 games endpoint
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
        params: { teamId }
      });

      res.json({
        success: true,
        data: response.data,
        lastUpdated: new Date().toISOString()
      });
    } catch (error) {
      console.error(`Error fetching ${sport} last 5 games:`, error.message);
      res.status(500).json({
        success: false,
        error: `Failed to fetch ${sport} last 5 games`,
        details: error.response?.data || error.message
      });
    }
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.send(`
    <h1>Sports Live Score API</h1>
    <h2>Supported Sports</h2>
    <ul>
      ${Object.keys(SPORTS).map(sport => `
        <li>
          <strong>${sport}</strong>
          <ul>
            <li>WebSocket: subscribe-matches/${sport}</li>
            <li>GET /api/${sport}/matches?date=YYYY-MM-DD (or leagueId=123)</li>
            <li>GET /api/${sport}/matches/:id</li>
            <li>GET /api/${sport}/highlights</li>
            <li>GET /api/${sport}/standings?leagueId=123&season=2023</li>
            <li>GET /api/${sport}/h2h?teamIdOne=123&teamIdTwo=456</li>
            <li>GET /api/${sport}/last5?teamId=123</li>
          </ul>
        </li>
      `).join('')}
    </ul>
    <p><strong>WebSocket URL:</strong> ws://${req.headers.host}</p>
    <p><strong>Real-time updates:</strong> Every ${UPDATE_INTERVAL/1000} seconds</p>
  `);
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}`);
  console.log(`HTTP: http://localhost:${PORT}`);
});