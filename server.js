// server.js - Railway API Backend for Neural Chatbot v5.0

require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database tables
const initDatabase = async () => {
  try {
    await pool.query(`
      -- Interactions table
      CREATE TABLE IF NOT EXISTS interactions (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(50) NOT NULL,
        user_prompt TEXT NOT NULL,
        bot_response TEXT NOT NULL,
        script TEXT,
        timestamp BIGINT,
        intent VARCHAR(50),
        confidence FLOAT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_id (user_id),
        INDEX idx_timestamp (timestamp)
      );

      -- Learning patterns table
      CREATE TABLE IF NOT EXISTS learning_patterns (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(50) NOT NULL,
        patterns JSONB NOT NULL,
        pattern_type VARCHAR(50),
        success_rate FLOAT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_patterns (user_id)
      );

      -- User preferences table
      CREATE TABLE IF NOT EXISTS user_preferences (
        user_id VARCHAR(50) PRIMARY KEY,
        personality VARCHAR(50) DEFAULT 'Friendly',
        settings JSONB,
        total_interactions INTEGER DEFAULT 0,
        last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Script analytics table
      CREATE TABLE IF NOT EXISTS script_analytics (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(50),
        script_type VARCHAR(50),
        execution_success BOOLEAN,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_script_type (script_type)
      );

      -- Bayesian network probabilities
      CREATE TABLE IF NOT EXISTS bayesian_probs (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(50),
        intent VARCHAR(50),
        prior_probability FLOAT,
        conditional_probs JSONB,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, intent)
      );
    `);
    
    console.log('✅ Database initialized successfully');
  } catch (err) {
    console.error('❌ Database initialization error:', err);
  }
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: '5.0'
  });
});

// Sync interactions endpoint
app.post('/api/sync', async (req, res) => {
  const { userId, data } = req.body;

  if (!userId || !data || !Array.isArray(data)) {
    return res.status(400).json({ error: 'Invalid request format' });
  }

  try {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      for (const item of data) {
        if (item.Type === 'interaction' && item.Data) {
          await client.query(
            `INSERT INTO interactions 
            (user_id, user_prompt, bot_response, script, timestamp) 
            VALUES ($1, $2, $3, $4, $5)`,
            [
              userId,
              item.Data.UserPrompt || '',
              item.Data.BotResponse || '',
              item.Data.Script || null,
              item.Timestamp || Date.now()
            ]
          );
        }
      }

      // Update user preferences
      await client.query(
        `INSERT INTO user_preferences (user_id, total_interactions, last_active)
        VALUES ($1, $2, NOW())
        ON CONFLICT (user_id) 
        DO UPDATE SET 
          total_interactions = user_preferences.total_interactions + $2,
          last_active = NOW()`,
        [userId, data.length]
      );

      await client.query('COMMIT');
      
      res.json({ 
        success: true, 
        synced: data.length,
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get user data endpoint
app.get('/api/user/:userId', async (req, res) => {
  const { userId } = req.params;
  const limit = parseInt(req.query.limit) || 100;

  try {
    const [interactions, preferences, patterns] = await Promise.all([
      pool.query(
        `SELECT * FROM interactions 
        WHERE user_id = $1 
        ORDER BY created_at DESC 
        LIMIT $2`,
        [userId, limit]
      ),
      pool.query(
        'SELECT * FROM user_preferences WHERE user_id = $1',
        [userId]
      ),
      pool.query(
        `SELECT * FROM learning_patterns 
        WHERE user_id = $1 
        ORDER BY created_at DESC 
        LIMIT 50`,
        [userId]
      )
    ]);

    res.json({
      interactions: interactions.rows,
      preferences: preferences.rows[0] || null,
      patterns: patterns.rows,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Save learning patterns endpoint
app.post('/api/learning', async (req, res) => {
  const { userId, patterns, patternType, successRate } = req.body;

  if (!userId || !patterns) {
    return res.status(400).json({ error: 'Invalid request format' });
  }

  try {
    await pool.query(
      `INSERT INTO learning_patterns 
      (user_id, patterns, pattern_type, success_rate) 
      VALUES ($1, $2, $3, $4)`,
      [userId, JSON.stringify(patterns), patternType || 'general', successRate || 0]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Learning save error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update Bayesian probabilities endpoint
app.post('/api/bayesian/update', async (req, res) => {
  const { userId, intent, priorProb, conditionalProbs } = req.body;

  if (!userId || !intent || priorProb === undefined) {
    return res.status(400).json({ error: 'Invalid request format' });
  }

  try {
    await pool.query(
      `INSERT INTO bayesian_probs 
      (user_id, intent, prior_probability, conditional_probs, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id, intent)
      DO UPDATE SET
        prior_probability = $3,
        conditional_probs = $4,
        updated_at = NOW()`,
      [userId, intent, priorProb, JSON.stringify(conditionalProbs || {})]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Bayesian update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get Bayesian probabilities endpoint
app.get('/api/bayesian/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const result = await pool.query(
      'SELECT * FROM bayesian_probs WHERE user_id = $1',
      [userId]
    );

    res.json({
      probabilities: result.rows,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Bayesian get error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Save script analytics endpoint
app.post('/api/analytics/script', async (req, res) => {
  const { userId, scriptType, executionSuccess, errorMessage } = req.body;

  try {
    await pool.query(
      `INSERT INTO script_analytics 
      (user_id, script_type, execution_success, error_message)
      VALUES ($1, $2, $3, $4)`,
      [userId, scriptType, executionSuccess, errorMessage || null]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Analytics save error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get analytics endpoint
app.get('/api/analytics/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const [scriptStats, interactionStats] = await Promise.all([
      pool.query(
        `SELECT 
          script_type,
          COUNT(*) as total,
          SUM(CASE WHEN execution_success THEN 1 ELSE 0 END) as successful
        FROM script_analytics
        WHERE user_id = $1
        GROUP BY script_type`,
        [userId]
      ),
      pool.query(
        `SELECT 
          DATE(created_at) as date,
          COUNT(*) as interactions
        FROM interactions
        WHERE user_id = $1
        AND created_at > NOW() - INTERVAL '30 days'
        GROUP BY DATE(created_at)
        ORDER BY date DESC`,
        [userId]
      )
    ]);

    res.json({
      scriptStats: scriptStats.rows,
      interactionStats: interactionStats.rows,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Analytics get error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update user preferences endpoint
app.put('/api/user/:userId/preferences', async (req, res) => {
  const { userId } = req.params;
  const { personality, settings } = req.body;

  try {
    await pool.query(
      `INSERT INTO user_preferences (user_id, personality, settings)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id)
      DO UPDATE SET
        personality = COALESCE($2, user_preferences.personality),
        settings = COALESCE($3, user_preferences.settings)`,
      [userId, personality, settings ? JSON.stringify(settings) : null]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Preferences update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get global statistics endpoint (for admin)
app.get('/api/stats/global', async (req, res) => {
  try {
    const [totalUsers, totalInteractions, scriptTypes] = await Promise.all([
      pool.query('SELECT COUNT(DISTINCT user_id) as count FROM interactions'),
      pool.query('SELECT COUNT(*) as count FROM interactions'),
      pool.query(`
        SELECT script_type, COUNT(*) as count
        FROM script_analytics
        GROUP BY script_type
        ORDER BY count DESC
        LIMIT 10
      `)
    ]);

    res.json({
      totalUsers: totalUsers.rows[0].count,
      totalInteractions: totalInteractions.rows[0].count,
      topScriptTypes: scriptTypes.rows,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Global stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: err.message 
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Start server
const PORT = process.env.PORT || 3000;

const startServer = async () => {
  await initDatabase();
  
  app.listen(PORT, () => {
    console.log('═══════════════════════════════════════════════════');
    console.log('🚂 Railway API Server for Neural Chatbot v5.0');
    console.log('═══════════════════════════════════════════════════');
    console.log(`🌐 Server running on port ${PORT}`);
    console.log(`📊 Database: ${process.env.DATABASE_URL ? 'Connected' : 'Not configured'}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/health`);
    console.log('═══════════════════════════════════════════════════');
  });
};

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

module.exports = app;
