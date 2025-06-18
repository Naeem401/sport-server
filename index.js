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

const UPDATE_INTERVAL = 60000; // 1 minute updates
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

// Track active subscriptions and API calls
const activeSubscriptions = {};
const activeMatchSubscriptions = {};
const apiCallTracker = {
  sports: {},
  matches: {},
  lastUpdated: null,
  totalCalls: 0
};

// Initialize subscriptions
Object.keys(SPORTS).forEach(sport => {
  activeSubscriptions[sport] = {
    users: new Set(),
    interval: null,
    isActive: false,
    lastUpdated: null
  };
  activeMatchSubscriptions[sport] = {};
  apiCallTracker.sports[sport] = {
    count: 0,
    lastCalled: null
  };
});

// Fetch match details without caching
async function fetchMatchDetails(sport, matchId) {
  try {
    // Track API call
    apiCallTracker.totalCalls++;
    if (!apiCallTracker.matches[matchId]) {
      apiCallTracker.matches[matchId] = { count: 0, lastCalled: null };
    }
    apiCallTracker.matches[matchId].count++;
    apiCallTracker.matches[matchId].lastCalled = new Date();
    apiCallTracker.sports[sport].count++;
    apiCallTracker.sports[sport].lastCalled = new Date();
    apiCallTracker.lastUpdated = new Date();

    const response = await axios.get(`${API_BASE_URL}/${SPORTS[sport]}/matches/${matchId}`, {
      headers: {
        'x-rapidapi-key': API_KEY,
        'x-rapidapi-host': 'sport-highlights-api.p.rapidapi.com'
      },
      timeout: 5000
    });

    return response.data;
  } catch (error) {
    console.error(`Error fetching ${sport} match details:`, error.message);
    return null;
  }
}

// Fetch matches without caching
async function fetchMatches(sport, params = {}, retries = 3) {
  try {
    apiCallTracker.totalCalls++;
    apiCallTracker.sports[sport].count++;
    apiCallTracker.sports[sport].lastCalled = new Date();
    apiCallTracker.lastUpdated = new Date();

    const response = await axios.get(`${API_BASE_URL}/${SPORTS[sport]}/matches`, {
      headers: {
        'x-rapidapi-key': API_KEY,
        'x-rapidapi-host': 'sport-highlights-api.p.rapidapi.com'
      },
      params: {
        date: params.date,
        timezone: params.timezone || 'UTC',
        limit: params.limit || 100
      },
      timeout: 10000
    });

    // Handle different possible response formats
    if (Array.isArray(response.data)) {
      return response.data;
    } else if (response.data && Array.isArray(response.data.data)) {
      return response.data.data;
    } else if (response.data && Array.isArray(response.data.matches)) {
      return response.data.matches;
    } else if (response.data && response.data.results) {
      return Array.isArray(response.data.results) ? response.data.results : [];
    } else {
      console.warn('Unexpected API response format:', response.data);
      return [];
    }
  } catch (error) {
    console.error(`Error fetching ${sport} matches (attempt ${4-retries}):`, error.message);
    
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
        let matches = await fetchMatches(sport, { date: today });
        
        // Ensure matches is always an array
        if (!Array.isArray(matches)) {
          console.error('Matches is not an array:', matches);
          matches = [];
        }

        const subscribedMatches = Object.keys(activeMatchSubscriptions[sport]);
        const relevantMatches = matches.filter(match => 
          match && match.id && subscribedMatches.includes(match.id)
        );
        
        // Process match updates
        const updatePromises = relevantMatches.map(async match => {
          try {
            const details = await fetchMatchDetails(sport, match.id);
            if (details) {
              io.to(`${sport}-${match.id}`).emit('match-update', {
                sport,
                matchId: match.id,
                data: details,
                lastUpdated: new Date().toISOString()
              });
            }
          } catch (error) {
            console.error(`Error updating match ${match.id}:`, error.message);
          }
        });

        await Promise.all(updatePromises);

        // Broadcast general matches update
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
        (now - (activeSubscriptions[sport].lastUpdated || 0)) > INACTIVITY_TIMEOUT) {
      if (activeSubscriptions[sport].interval) {
        clearInterval(activeSubscriptions[sport].interval);
        activeSubscriptions[sport].interval = null;
        activeSubscriptions[sport].isActive = false;
        console.log(`Cleaned up inactive ${sport} subscriptions`);
      }
    }
    
    Object.keys(activeMatchSubscriptions[sport]).forEach(matchId => {
      if (activeMatchSubscriptions[sport][matchId].size === 0) {
        delete activeMatchSubscriptions[sport][matchId];
      }
    });
  });
}

setInterval(cleanupInactiveSubscriptions, 60000);

// Socket.io for real-time matches
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  socket.on('subscribe-matches', (sport) => {
    if (!SPORTS[sport]) {
      return socket.emit('error', { message: 'Invalid sport specified' });
    }

    socket.join(sport);
    activeSubscriptions[sport].users.add(socket.id);
    
    if (!activeSubscriptions[sport].isActive) {
      startMatchUpdates(sport);
    }

    console.log(`Client ${socket.id} subscribed to real-time ${sport} matches`);
  });

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

    console.log(`Client ${socket.id} subscribed to real-time ${sport} match ${matchId}`);
  });

  socket.on('unsubscribe-matches', (sport) => {
    if (!SPORTS[sport]) return;
    
    socket.leave(sport);
    activeSubscriptions[sport].users.delete(socket.id);
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
      }
      
      Object.keys(activeMatchSubscriptions[sport]).forEach(matchId => {
        if (activeMatchSubscriptions[sport][matchId].has(socket.id)) {
          activeMatchSubscriptions[sport][matchId].delete(socket.id);
        }
      });
    });
  });
});

// API to get API call stats and active routes
app.get('/api/stats', (req, res) => {
  const activeSports = Object.keys(SPORTS).filter(sport => 
    activeSubscriptions[sport].isActive
  );
  
  const activeMatches = Object.keys(SPORTS).reduce((acc, sport) => {
    const matches = Object.keys(activeMatchSubscriptions[sport]);
    if (matches.length > 0) {
      acc[sport] = matches;
    }
    return acc;
  }, {});

  res.json({
    success: true,
    stats: {
      totalApiCalls: apiCallTracker.totalCalls,
      lastUpdated: apiCallTracker.lastUpdated,
      bySport: apiCallTracker.sports,
      byMatch: apiCallTracker.matches
    },
    activeRoutes: {
      sports: activeSports,
      matches: activeMatches
    },
    subscriptionCounts: {
      sports: Object.keys(SPORTS).map(sport => ({
        sport,
        users: activeSubscriptions[sport].users.size,
        isActive: activeSubscriptions[sport].isActive
      })),
      matches: Object.keys(SPORTS).reduce((acc, sport) => {
        const matches = Object.keys(activeMatchSubscriptions[sport]).map(matchId => ({
          matchId,
          users: activeMatchSubscriptions[sport][matchId].size
        }));
        if (matches.length > 0) {
          acc[sport] = matches;
        }
        return acc;
      }, {})
    }
  });
});

// REST API Endpoints
Object.keys(SPORTS).forEach(sport => {
 app.get(`/api/${sport}/matches`, async (req, res) => {
    try {
      const { date, timezone = 'UTC', limit = 100 } = req.query;
      
      if (!date) {
        return res.status(400).json({
          success: false,
          error: 'Date parameter is required'
        });
      }

      let matches = await fetchMatches(sport, { date, timezone, limit });
      
      // Ensure we always return an array
      if (!Array.isArray(matches)) {
        console.warn('Unexpected matches format, converting to array');
        matches = [];
      }

      res.json({
        success: true,
        sport,
        data: matches,
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
    <p><a href="/api/stats">View API Call Statistics</a></p>
    <h2>Supported Sports</h2>
    <ul>
      ${Object.keys(SPORTS).map(sport => `
        <li>
          <strong>${sport}</strong>
          <ul>
            <li>WebSocket: subscribe-matches/${sport} (real-time)</li>
            <li>GET /api/${sport}/matches?date=YYYY-MM-DD&timezone=Timezone</li>
            <li>GET /api/${sport}/matches/:id</li>
            <li>GET /api/${sport}/highlights</li>
            <li>GET /api/${sport}/standings</li>
            <li>GET /api/${sport}/h2h</li>
            <li>GET /api/${sport}/last5</li>
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
  console.log(`WebSocket: ws://localhost:${PORT}`);
  console.log(`HTTP: http://localhost:${PORT}`);
});


