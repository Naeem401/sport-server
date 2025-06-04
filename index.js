require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const moment = require('moment');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

// Middleware
app.use(cors());
app.use(express.json());

// API Configuration
const API_BASE_URL = 'https://sport-highlights-api.p.rapidapi.com';
const API_KEY = process.env.API_KEY || 'e8555e69a8msh1de65d7c1cbf7d1p1bd3b7jsn2efec15ed0d5';
const UPDATE_INTERVAL = 60000; // 1 minute
const CACHE_TTL = 60000; // 1 minute cache
const MAX_LIMIT = 100; // Maximum matches per request
const DAYS_RANGE = 7; // 7 days data
const INACTIVITY_TIMEOUT = 300000; // 5 minutes inactivity

// Data Structures
const sportDataCache = new Map();
const activeSubscriptions = {
  football: { users: new Set(), interval: null, lastActive: null },
  basketball: { users: new Set(), interval: null, lastActive: null },
  hockey: { users: new Set(), interval: null, lastActive: null },
  rugby: { users: new Set(), interval: null, lastActive: null },
  handball: { users: new Set(), interval: null, lastActive: null },
  volleyball: { users: new Set(), interval: null, lastActive: null },
  cricket: { users: new Set(), interval: null, lastActive: null },
  baseball: { users: new Set(), interval: null, lastActive: null }
};

// Helper functions
function getDateRange(days = DAYS_RANGE) {
  const startDate = moment().subtract(Math.floor(days/2), 'days');
  const dates = [];
  for (let i = 0; i < days; i++) {
    dates.push(startDate.clone().add(i, 'days').format('YYYY-MM-DD'));
  }
  return dates;
}

function buildCacheKey(sport, params = {}) {
  const sortedParams = Object.keys(params).sort().reduce((acc, key) => {
    acc[key] = params[key];
    return acc;
  }, {});
  return `${sport}:${JSON.stringify(sortedParams)}`;
}

// Start/stop update intervals
function startSportUpdates(sport) {
  if (activeSubscriptions[sport].interval) return;

  // Initial fetch
  fetchSportData(sport).then(data => {
    if (data) {
      io.to(sport).emit(`${sport}-update`, {
        meta: { lastUpdated: new Date().toISOString() },
        data
      });
    }
  });

  // Set up interval
  activeSubscriptions[sport].interval = setInterval(async () => {
    const data = await fetchSportData(sport);
    if (data) {
      io.to(sport).emit(`${sport}-update`, {
        meta: { lastUpdated: new Date().toISOString() },
        data
      });
    }
    activeSubscriptions[sport].lastActive = Date.now();
  }, UPDATE_INTERVAL);

  console.log(`Started ${sport} updates with ${UPDATE_INTERVAL/1000}s interval`);
}

function stopSportUpdates(sport) {
  if (activeSubscriptions[sport].interval) {
    clearInterval(activeSubscriptions[sport].interval);
    activeSubscriptions[sport].interval = null;
    console.log(`Stopped ${sport} updates`);
  }
}

// Check for inactive sports every minute
setInterval(() => {
  const now = Date.now();
  Object.keys(activeSubscriptions).forEach(sport => {
    if (activeSubscriptions[sport].users.size === 0 && 
        activeSubscriptions[sport].lastActive && 
        (now - activeSubscriptions[sport].lastActive) > INACTIVITY_TIMEOUT) {
      stopSportUpdates(sport);
    }
  });
}, 60000);

// Fetch sport data with optimization
async function fetchSportData(sport, params = {}) {
  const cacheKey = buildCacheKey(sport, params);
  const cachedData = sportDataCache.get(cacheKey);
  
  // Return cached data if valid
  if (cachedData && Date.now() - cachedData.timestamp < CACHE_TTL) {
    return cachedData.data;
  }

  try {
    // First try to fetch all matches in one call
    const response = await axios.get(`${API_BASE_URL}/${sport}/matches`, {
      params: {
        ...params,
        limit: MAX_LIMIT
      },
      headers: {
        'x-rapidapi-key': API_KEY,
        'x-rapidapi-host': new URL(API_BASE_URL).hostname
      }
    });

    let matches = Array.isArray(response.data) ? response.data : [response.data];
    
    // If max limit reached, fetch by date
    if (matches.length >= MAX_LIMIT) {
      console.log(`Hit max limit for ${sport}, using date-based fetching`);
      return await fetchDataByDate(sport, params);
    }

    // Cache results
    sportDataCache.set(cacheKey, {
      data: matches,
      timestamp: Date.now()
    });

    return matches;
  } catch (error) {
    console.error(`Error fetching ${sport} data:`, error.message);
    
    // Fallback to date-based fetching
    if (error.response?.status === 400 || error.response?.status === 500) {
      return await fetchDataByDate(sport, params);
    }
    
    // Return stale cache if available
    if (cachedData) {
      console.log(`Returning stale cache for ${sport}`);
      return cachedData.data;
    }
    
    throw error;
  }
}

// Fetch data by individual dates
async function fetchDataByDate(sport, params = {}) {
  const dates = getDateRange();
  let allData = [];

  for (const date of dates) {
    try {
      const response = await axios.get(`${API_BASE_URL}/${sport}/matches`, {
        params: {
          ...params,
          date,
          limit: MAX_LIMIT
        },
        headers: {
          'x-rapidapi-key': API_KEY,
          'x-rapidapi-host': new URL(API_BASE_URL).hostname
        }
      });

      if (response.data) {
        const data = Array.isArray(response.data) ? response.data : [response.data];
        allData = [...allData, ...data];
      }
    } catch (error) {
      console.error(`Error fetching ${sport} data for ${date}:`, error.message);
    }
  }

  // Cache combined results
  const cacheKey = buildCacheKey(sport, params);
  sportDataCache.set(cacheKey, {
    data: allData,
    timestamp: Date.now()
  });

  return allData;
}

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Subscribe to sport
  socket.on('subscribe', ({ sport }) => {
    if (!sport || !activeSubscriptions[sport]) {
      return socket.emit('error', { message: 'Invalid sport specified' });
    }

    socket.join(sport);
    activeSubscriptions[sport].users.add(socket.id);
    
    // Start updates if first subscriber
    if (activeSubscriptions[sport].users.size === 1) {
      startSportUpdates(sport);
    }

    // Send initial data
    const cachedData = sportDataCache.get(buildCacheKey(sport));
    if (cachedData) {
      socket.emit(`${sport}-update`, {
        meta: { lastUpdated: new Date(cachedData.timestamp).toISOString() },
        data: cachedData.data
      });
    }

    console.log(`Client ${socket.id} subscribed to ${sport}`);
  });

  // Unsubscribe from sport
  socket.on('unsubscribe', ({ sport }) => {
    if (!sport || !activeSubscriptions[sport]) return;

    socket.leave(sport);
    activeSubscriptions[sport].users.delete(socket.id);
    
    // Update last active time
    if (activeSubscriptions[sport].users.size === 0) {
      activeSubscriptions[sport].lastActive = Date.now();
    }

    console.log(`Client ${socket.id} unsubscribed from ${sport}`);
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    // Clean up subscriptions
    Object.keys(activeSubscriptions).forEach(sport => {
      if (activeSubscriptions[sport].users.has(socket.id)) {
        activeSubscriptions[sport].users.delete(socket.id);
        
        if (activeSubscriptions[sport].users.size === 0) {
          activeSubscriptions[sport].lastActive = Date.now();
        }
      }
    });
  });
});

// ======================== REST ENDPOINTS ========================

// Generic sport matches endpoint
app.get('/:sport/matches', async (req, res) => {
  const { sport } = req.params;
  
  if (!activeSubscriptions[sport]) {
    return res.status(400).json({ error: 'Invalid sport specified' });
  }

  try {
    const { 
      date, leagueId, leagueName, season, 
      countryCode, timezone, homeTeamId, awayTeamId 
    } = req.query;
    
    const params = {};
    if (date) params.date = date;
    if (leagueId) params.leagueId = leagueId;
    if (leagueName) params.leagueName = leagueName;
    if (season) params.season = season;
    if (countryCode) params.countryCode = countryCode;
    if (timezone) params.timezone = timezone;
    if (homeTeamId) params.homeTeamId = homeTeamId;
    if (awayTeamId) params.awayTeamId = awayTeamId;

    const data = await fetchSportData(sport, params);
    
    res.json({
      meta: {
        lastUpdated: new Date().toISOString(),
        totalResults: data.length,
        sport,
        parameters: params
      },
      data
    });
  } catch (error) {
    console.error(`${sport} API Error:`, error.message);
    res.status(500).json({ 
      error: `Failed to fetch ${sport} data`,
      details: error.response?.data || error.message
    });
  }
});

// Football-specific endpoints
app.get('/football/standings', async (req, res) => {
  try {
    const { leagueId, season } = req.query;

    if (!leagueId || !season) {
      return res.status(400).json({
        error: 'Missing required parameters',
        details: 'Both leagueId and season are required'
      });
    }

    const response = await axios.get(`${API_BASE_URL}/football/standings`, {
      params: { leagueId, season },
      headers: {
        'x-rapidapi-key': API_KEY,
        'x-rapidapi-host': new URL(API_BASE_URL).hostname
      }
    });

    res.json({
      meta: {
        lastUpdated: new Date().toISOString(),
        leagueId,
        season
      },
      data: response.data
    });
  } catch (error) {
    console.error('Standings API Error:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch standings',
      details: error.response?.data || error.message
    });
  }
});

app.get('/football/highlights', async (req, res) => {
  try {
    // Extract query parameters with defaults
    const { 
      date, 
      limit = 20, 
      countryCode,
      leagueId,
      timezone = 'Etc/UTC',
      offset = 0
    } = req.query;

    // Always use last 7 days as default date range
    const dates = getDateRange(); // This will always return 7 dates
    
    // Build params object
    const params = {
      limit: Math.min(limit, 40), // Enforce maximum limit of 40
      offset,
      timezone
    };

    // Add optional parameters (excluding matchId)
    if (countryCode) params.countryCode = countryCode;
    if (leagueId) params.leagueId = leagueId;

    // Fetch highlights for each date in the 7-day range
    let allHighlights = [];
    for (const currentDate of dates) {
      try {
        const response = await axios.get(`${API_BASE_URL}/football/highlights`, {
          params: {
            ...params,
            date: currentDate
          },
          headers: {
            'x-rapidapi-key': API_KEY,
            'x-rapidapi-host': new URL(API_BASE_URL).hostname
          }
        });

        if (response.data) {
          const highlights = Array.isArray(response.data) ? response.data : [response.data];
          allHighlights = [...allHighlights, ...highlights];
        }
      } catch (error) {
        console.error(`Error fetching highlights for date ${currentDate}:`, error.message);
      }
    }

    // Prepare response with date range info
    res.json({
      meta: {
        lastUpdated: new Date().toISOString(),
        parameters: params,
        totalResults: allHighlights.length,
        dateRange: {
          startDate: dates[0],
          endDate: dates[dates.length - 1],
          days: dates.length
        }
      },
      data: allHighlights,
      pagination: {
        limit: params.limit,
        offset: params.offset,
        nextOffset: params.offset + params.limit
      }
    });

  } catch (error) {
    console.error('Football Highlights API Error:', error.message);
    
    if (error.response) {
      res.status(error.response.status).json({
        error: 'Failed to fetch football highlights',
        details: error.response.data,
        status: error.response.status
      });
    } else {
      res.status(500).json({ 
        error: 'Internal server error',
        details: error.message
      });
    }
  }
});

app.get('/football/highlights/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!id) {
      return res.status(400).json({ error: 'Highlight ID is required' });
    }

    const response = await axios.get(`${API_BASE_URL}/football/highlights/${id}`, {
      headers: {
        'x-rapidapi-key': API_KEY,
        'x-rapidapi-host': new URL(API_BASE_URL).hostname
      }
    });

    res.json({
      meta: {
        lastUpdated: new Date().toISOString()
      },
      data: response.data
    });
  } catch (error) {
    console.error('Highlight API Error:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch highlight',
      details: error.response?.data || error.message
    });
  }
});

app.get('/football/h2h', async (req, res) => {
  try {
    const { team1, team2 } = req.query;
    
    if (!team1 || !team2) {
      return res.status(400).json({ 
        error: 'Both team1 and team2 parameters are required' 
      });
    }

    const response = await axios.get(`${API_BASE_URL}/football/matches/head-to-head`, {
      params: { h2h: `${team1}-${team2}` },
      headers: {
        'x-rapidapi-key': API_KEY,
        'x-rapidapi-host': new URL(API_BASE_URL).hostname
      }
    });

    res.json({
      meta: {
        lastUpdated: new Date().toISOString(),
        team1,
        team2
      },
      data: response.data
    });
  } catch (error) {
    console.error('H2H API Error:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch head-to-head data',
      details: error.response?.data || error.message
    });
  }
});


// Cricket highlight by ID endpoint
app.get('/cricket/highlights/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Validate ID
    if (!id || isNaN(Number(id))) {
      return res.status(400).json({ 
        error: 'Invalid highlight ID',
        details: 'ID must be a numeric value'
      });
    }

    // Get headers with fallback to environment variables
    const rapidApiHost = req.headers['x-rapidapi-host'] || 'sport-highlights-api.p.rapidapi.com';
    const rapidApiKey = req.headers['x-rapidapi-key'] || API_KEY;
    
    // Make request to external API
    const response = await axios.get(`${API_BASE_URL}/cricket/highlights/${id}`, {
      headers: {
        'x-rapidapi-key': rapidApiKey,
        'x-rapidapi-host': rapidApiHost
      }
    });

    // Return successful response
    res.json({
      meta: {
        id: Number(id),
        retrievedAt: new Date().toISOString(),
        sport: 'cricket'
      },
      data: response.data
    });

  } catch (error) {
    console.error('Cricket Highlight by ID Error:', error.message);
    
    if (error.response) {
      res.status(error.response.status).json({
        error: 'Failed to retrieve cricket highlight',
        details: error.response.data
      });
    } else if (error.request) {
      res.status(503).json({
        error: 'Service unavailable',
        details: 'Could not connect to highlight service'
      });
    } else {
      res.status(500).json({
        error: 'Internal server error',
        details: error.message
      });
    }
  }
});
// Root endpoint
app.get('/', (req, res) => {
  const sports = Object.keys(activeSubscriptions);
  
  res.send(`
    <h1>Sports API Server</h1>
    <p><strong>WebSocket URL:</strong> ws://${req.headers.host}</p>
    <p><strong>Update Interval:</strong> ${UPDATE_INTERVAL/1000} seconds</p>
    
    <h2>Available Sports</h2>
    <ul>
      ${sports.map(sport => `
        <li>
          <strong>${sport}</strong>
          <ul>
            <li>GET /${sport}/matches - Get matches</li>
            ${sport === 'football' ? `
              <li>GET /football/standings - Get league standings</li>
              <li>GET /football/highlights - Get highlights</li>
              <li>GET /football/highlights/:id - Get specific highlight</li>
              <li>GET /football/h2h - Head-to-head comparison</li>
            ` : ''}
          </ul>
        </li>
      `).join('')}
    </ul>
    
    <h2>WebSocket Instructions</h2>
    <p>Send JSON message to subscribe: <code>{ "sport": "football" }</code></p>
    <p>Send JSON message to unsubscribe: <code>{ "sport": "football", "action": "unsubscribe" }</code></p>
    <p>You will receive updates every ${UPDATE_INTERVAL/1000} seconds</p>
  `);
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
  console.log(`HTTP endpoint: http://localhost:${PORT}`);
});