// server.js — NeuralChatbot v7 Railway Backend
// Adds: trained_responses table + CRUD, improved DB schema

require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const cors     = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ═══════════════════════════════════════════════════════════════
// DATABASE CONNECTION
// Railway injects DATABASE_URL automatically when you link a
// PostgreSQL service. Make sure the two services are linked.
// ═══════════════════════════════════════════════════════════════
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("railway")
        ? { rejectUnauthorized: false }
        : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
    console.error("Unexpected PG pool error:", err.message);
});

// ═══════════════════════════════════════════════════════════════
// SCHEMA INIT
// ═══════════════════════════════════════════════════════════════
async function initDB() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS interactions (
                id           SERIAL PRIMARY KEY,
                user_id      VARCHAR(64)  NOT NULL,
                user_prompt  TEXT         NOT NULL,
                bot_response TEXT         NOT NULL,
                script       TEXT,
                intent       VARCHAR(64),
                confidence   FLOAT,
                timestamp    BIGINT,
                created_at   TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS vocab (
                id           SERIAL PRIMARY KEY,
                user_id      VARCHAR(64)  NOT NULL,
                word         VARCHAR(128) NOT NULL,
                freq         INTEGER DEFAULT 1,
                category     VARCHAR(64)  DEFAULT 'general',
                weight       FLOAT        DEFAULT 1.0,
                updated_at   TIMESTAMP DEFAULT NOW(),
                UNIQUE (user_id, word)
            );

            CREATE TABLE IF NOT EXISTS learning_patterns (
                id           SERIAL PRIMARY KEY,
                user_id      VARCHAR(64)  NOT NULL,
                patterns     JSONB        NOT NULL,
                pattern_type VARCHAR(64)  DEFAULT 'general',
                success_rate FLOAT        DEFAULT 0,
                created_at   TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS user_preferences (
                user_id            VARCHAR(64) PRIMARY KEY,
                personality        VARCHAR(64) DEFAULT 'Friendly',
                settings           JSONB,
                total_interactions INTEGER DEFAULT 0,
                last_active        TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS bayesian_probs (
                id                SERIAL PRIMARY KEY,
                user_id           VARCHAR(64) NOT NULL,
                intent            VARCHAR(64) NOT NULL,
                prior_probability FLOAT,
                conditional_probs JSONB,
                updated_at        TIMESTAMP DEFAULT NOW(),
                UNIQUE (user_id, intent)
            );

            CREATE TABLE IF NOT EXISTS script_analytics (
                id                SERIAL PRIMARY KEY,
                user_id           VARCHAR(64),
                script_type       VARCHAR(64),
                execution_success BOOLEAN,
                error_message     TEXT,
                created_at        TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS trained_responses (
                id           SERIAL PRIMARY KEY,
                user_id      VARCHAR(64)  NOT NULL,
                pattern      TEXT         NOT NULL,
                response     TEXT         NOT NULL,
                script       TEXT         DEFAULT '',
                created_at   TIMESTAMP DEFAULT NOW()
            );
        `);

        // Create indexes separately (correct PostgreSQL syntax)
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_interactions_user   ON interactions      (user_id);
            CREATE INDEX IF NOT EXISTS idx_interactions_ts     ON interactions      (timestamp);
            CREATE INDEX IF NOT EXISTS idx_vocab_user          ON vocab             (user_id);
            CREATE INDEX IF NOT EXISTS idx_vocab_word          ON vocab             (word);
            CREATE INDEX IF NOT EXISTS idx_learning_user       ON learning_patterns (user_id);
            CREATE INDEX IF NOT EXISTS idx_analytics_type      ON script_analytics  (script_type);
            CREATE INDEX IF NOT EXISTS idx_training_user       ON trained_responses (user_id);
        `);

        console.log("✅ Database schema ready (v7)");
    } finally {
        client.release();
    }
}

// ═══════════════════════════════════════════════════════════════
// HEALTH
// ═══════════════════════════════════════════════════════════════
app.get("/health", async (req, res) => {
    let dbOk = false;
    try {
        await pool.query("SELECT 1");
        dbOk = true;
    } catch {}
    res.json({
        status: "healthy",
        db: dbOk ? "connected" : "error",
        version: "7.0",
        ts: new Date().toISOString()
    });
});

// ═══════════════════════════════════════════════════════════════
// SYNC  (batch interactions + vocab)
// ═══════════════════════════════════════════════════════════════
app.post("/api/sync", async (req, res) => {
    const { userId, data } = req.body;
    if (!userId || !Array.isArray(data))
        return res.status(400).json({ error: "Invalid body" });

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        let interactions = 0;
        let vocabUpdates = 0;

        for (const item of data) {
            if (item.Type === "interaction" && item.Data) {
                await client.query(
                    `INSERT INTO interactions
                        (user_id, user_prompt, bot_response, script, intent, confidence, timestamp)
                     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                    [
                        userId,
                        item.Data.UserPrompt  || "",
                        item.Data.BotResponse || "",
                        item.Data.Script      || null,
                        item.Data.Intent      || null,
                        item.Data.Confidence  || null,
                        item.Timestamp        || Date.now(),
                    ]
                );
                interactions++;

            } else if (item.Type === "vocab" && item.Data) {
                for (const [word, info] of Object.entries(item.Data)) {
                    await client.query(
                        `INSERT INTO vocab (user_id, word, freq, category, weight)
                         VALUES ($1,$2,$3,$4,$5)
                         ON CONFLICT (user_id, word)
                         DO UPDATE SET
                            freq       = vocab.freq + EXCLUDED.freq,
                            weight     = GREATEST(vocab.weight, EXCLUDED.weight),
                            updated_at = NOW()`,
                        [userId, word, info.freq || 1, info.cat || "general", info.weight || 1.0]
                    );
                    vocabUpdates++;
                }
            }
        }

        await client.query(
            `INSERT INTO user_preferences (user_id, total_interactions, last_active)
             VALUES ($1,$2,NOW())
             ON CONFLICT (user_id)
             DO UPDATE SET
                total_interactions = user_preferences.total_interactions + $2,
                last_active        = NOW()`,
            [userId, interactions]
        );

        await client.query("COMMIT");
        res.json({ success: true, interactions, vocabUpdates, ts: new Date().toISOString() });

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Sync error:", err.message);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// ═══════════════════════════════════════════════════════════════
// VOCAB  —  save & load
// ═══════════════════════════════════════════════════════════════
app.post("/api/vocab/save", async (req, res) => {
    const { userId, vocab } = req.body;
    if (!userId || !vocab || typeof vocab !== "object")
        return res.status(400).json({ error: "Invalid body" });

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        let count = 0;
        for (const [word, info] of Object.entries(vocab)) {
            if (typeof word !== "string" || word.length > 128) continue;
            await client.query(
                `INSERT INTO vocab (user_id, word, freq, category, weight)
                 VALUES ($1,$2,$3,$4,$5)
                 ON CONFLICT (user_id, word)
                 DO UPDATE SET
                    freq       = GREATEST(vocab.freq, EXCLUDED.freq),
                    weight     = GREATEST(vocab.weight, EXCLUDED.weight),
                    updated_at = NOW()`,
                [userId, word, info.freq || 1, info.cat || "general", info.weight || 1.0]
            );
            count++;
        }
        await client.query("COMMIT");
        res.json({ success: true, saved: count });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Vocab save error:", err.message);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

app.get("/api/vocab/:userId", async (req, res) => {
    const { userId } = req.params;
    try {
        const result = await pool.query(
            `SELECT word, freq, category AS cat, weight
             FROM vocab
             WHERE user_id = $1
             ORDER BY freq * weight DESC
             LIMIT 5000`,
            [userId]
        );
        const vocab = {};
        for (const row of result.rows) {
            vocab[row.word] = { freq: row.freq, cat: row.cat, weight: parseFloat(row.weight) };
        }
        res.json({ vocab, count: result.rows.length, ts: new Date().toISOString() });
    } catch (err) {
        console.error("Vocab load error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// TRAINED RESPONSES  (new in v7)
// The bot's actual learning — user-defined prompt→response pairs
// ═══════════════════════════════════════════════════════════════

// Save a trained pair
app.post("/api/training/save", async (req, res) => {
    const { userId, pattern, response, script } = req.body;
    if (!userId || !pattern || !response)
        return res.status(400).json({ error: "userId, pattern, and response are required" });

    // Sanitize
    if (pattern.length > 500)
        return res.status(400).json({ error: "Pattern too long (max 500 chars)" });
    if (response.length > 5000)
        return res.status(400).json({ error: "Response too long (max 5000 chars)" });

    try {
        const result = await pool.query(
            `INSERT INTO trained_responses (user_id, pattern, response, script)
             VALUES ($1, $2, $3, $4)
             RETURNING id, created_at`,
            [userId, pattern.toLowerCase().trim(), response, script || ""]
        );
        res.json({ success: true, id: result.rows[0].id, created_at: result.rows[0].created_at });
    } catch (err) {
        console.error("Training save error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// Load all trained pairs for a user
app.get("/api/training/:userId", async (req, res) => {
    const { userId } = req.params;
    try {
        const result = await pool.query(
            `SELECT id, pattern, response, script, created_at AS ts
             FROM trained_responses
             WHERE user_id = $1
             ORDER BY created_at ASC`,
            [userId]
        );
        res.json({
            pairs: result.rows,
            count: result.rows.length,
            ts: new Date().toISOString()
        });
    } catch (err) {
        console.error("Training load error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// Delete a trained pair
app.delete("/api/training/:userId/:id", async (req, res) => {
    const { userId, id } = req.params;
    const numId = parseInt(id);
    if (isNaN(numId))
        return res.status(400).json({ error: "Invalid id" });
    try {
        const result = await pool.query(
            `DELETE FROM trained_responses
             WHERE user_id = $1 AND id = $2
             RETURNING id`,
            [userId, numId]
        );
        if (result.rows.length === 0)
            return res.status(404).json({ error: "Training pair not found" });
        res.json({ success: true, deleted: numId });
    } catch (err) {
        console.error("Training delete error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// USER DATA
// ═══════════════════════════════════════════════════════════════
app.get("/api/user/:userId", async (req, res) => {
    const { userId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    try {
        const [interactions, prefs, vocab, training] = await Promise.all([
            pool.query(
                `SELECT id, user_prompt, bot_response, intent, confidence, created_at
                 FROM interactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`,
                [userId, limit]
            ),
            pool.query("SELECT * FROM user_preferences WHERE user_id=$1", [userId]),
            pool.query(
                `SELECT word, freq, category, weight FROM vocab
                 WHERE user_id=$1 ORDER BY freq DESC LIMIT 200`,
                [userId]
            ),
            pool.query(
                `SELECT id, pattern, response FROM trained_responses
                 WHERE user_id=$1 ORDER BY created_at ASC`,
                [userId]
            ),
        ]);
        res.json({
            interactions: interactions.rows,
            preferences:  prefs.rows[0] || null,
            topVocab:     vocab.rows,
            trainedPairs: training.rows,
            ts: new Date().toISOString(),
        });
    } catch (err) {
        console.error("User data error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// LEARNING PATTERNS
// ═══════════════════════════════════════════════════════════════
app.post("/api/learning", async (req, res) => {
    const { userId, patterns, patternType, successRate } = req.body;
    if (!userId || !patterns) return res.status(400).json({ error: "Invalid body" });
    try {
        await pool.query(
            `INSERT INTO learning_patterns (user_id, patterns, pattern_type, success_rate)
             VALUES ($1,$2,$3,$4)`,
            [userId, JSON.stringify(patterns), patternType || "general", successRate || 0]
        );
        res.json({ success: true });
    } catch (err) {
        console.error("Learning save error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// BAYESIAN PROBABILITIES
// ═══════════════════════════════════════════════════════════════
app.post("/api/bayesian/update", async (req, res) => {
    const { userId, intent, priorProb, conditionalProbs } = req.body;
    if (!userId || !intent || priorProb === undefined)
        return res.status(400).json({ error: "Invalid body" });
    try {
        await pool.query(
            `INSERT INTO bayesian_probs (user_id, intent, prior_probability, conditional_probs, updated_at)
             VALUES ($1,$2,$3,$4,NOW())
             ON CONFLICT (user_id, intent)
             DO UPDATE SET
                prior_probability = $3,
                conditional_probs = $4,
                updated_at        = NOW()`,
            [userId, intent, priorProb, JSON.stringify(conditionalProbs || {})]
        );
        res.json({ success: true });
    } catch (err) {
        console.error("Bayesian update error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/bayesian/:userId", async (req, res) => {
    const { userId } = req.params;
    try {
        const result = await pool.query(
            "SELECT * FROM bayesian_probs WHERE user_id=$1", [userId]
        );
        res.json({ probabilities: result.rows, ts: new Date().toISOString() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// USER PREFERENCES
// ═══════════════════════════════════════════════════════════════
app.put("/api/user/:userId/preferences", async (req, res) => {
    const { userId } = req.params;
    const { personality, settings } = req.body;
    try {
        await pool.query(
            `INSERT INTO user_preferences (user_id, personality, settings)
             VALUES ($1,$2,$3)
             ON CONFLICT (user_id)
             DO UPDATE SET
                personality = COALESCE($2, user_preferences.personality),
                settings    = COALESCE($3::jsonb, user_preferences.settings),
                last_active = NOW()`,
            [userId, personality || null, settings ? JSON.stringify(settings) : null]
        );
        res.json({ success: true });
    } catch (err) {
        console.error("Prefs update error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// SCRIPT ANALYTICS
// ═══════════════════════════════════════════════════════════════
app.post("/api/analytics/script", async (req, res) => {
    const { userId, scriptType, executionSuccess, errorMessage } = req.body;
    try {
        await pool.query(
            `INSERT INTO script_analytics (user_id, script_type, execution_success, error_message)
             VALUES ($1,$2,$3,$4)`,
            [userId, scriptType, executionSuccess, errorMessage || null]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/analytics/:userId", async (req, res) => {
    const { userId } = req.params;
    try {
        const [scriptStats, interactionStats] = await Promise.all([
            pool.query(
                `SELECT script_type,
                        COUNT(*) AS total,
                        SUM(CASE WHEN execution_success THEN 1 ELSE 0 END) AS successful
                 FROM script_analytics WHERE user_id=$1
                 GROUP BY script_type`,
                [userId]
            ),
            pool.query(
                `SELECT DATE(created_at) AS date, COUNT(*) AS interactions
                 FROM interactions
                 WHERE user_id=$1 AND created_at > NOW() - INTERVAL '30 days'
                 GROUP BY DATE(created_at)
                 ORDER BY date DESC`,
                [userId]
            ),
        ]);
        res.json({
            scriptStats:      scriptStats.rows,
            interactionStats: interactionStats.rows,
            ts: new Date().toISOString(),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// GLOBAL STATS (admin)
// ═══════════════════════════════════════════════════════════════
app.get("/api/stats/global", async (req, res) => {
    try {
        const [users, total, topScripts, topVocab, topTraining] = await Promise.all([
            pool.query("SELECT COUNT(DISTINCT user_id) AS count FROM interactions"),
            pool.query("SELECT COUNT(*) AS count FROM interactions"),
            pool.query(`
                SELECT script_type, COUNT(*) AS cnt
                FROM script_analytics GROUP BY script_type ORDER BY cnt DESC LIMIT 10
            `),
            pool.query(`
                SELECT word, SUM(freq) AS total_freq
                FROM vocab GROUP BY word ORDER BY total_freq DESC LIMIT 20
            `),
            pool.query(`
                SELECT COUNT(*) AS count FROM trained_responses
            `),
        ]);
        res.json({
            totalUsers:         parseInt(users.rows[0].count),
            totalInteractions:  parseInt(total.rows[0].count),
            totalTrainedPairs:  parseInt(topTraining.rows[0].count),
            topScriptTypes:     topScripts.rows,
            globalTopVocab:     topVocab.rows,
            ts: new Date().toISOString(),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// ERROR HANDLERS
// ═══════════════════════════════════════════════════════════════
app.use((err, req, res, next) => {
    console.error("Unhandled error:", err.message);
    res.status(500).json({ error: "Internal server error" });
});
app.use((req, res) => res.status(404).json({ error: "Not found" }));

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;

(async () => {
    try {
        await initDB();
        app.listen(PORT, () => {
            console.log("═══════════════════════════════════════════════════");
            console.log("🚂 NeuralChatbot v7 — Railway API Server");
            console.log("═══════════════════════════════════════════════════");
            console.log(`🌐  Port     : ${PORT}`);
            console.log(`🗄️  Database : ${process.env.DATABASE_URL ? "✅ connected" : "❌ DATABASE_URL missing!"}`);
            console.log(`🔗  Health   : /health`);
            console.log(`🎓  Training : /api/training/:userId`);
            console.log("═══════════════════════════════════════════════════");
        });
    } catch (err) {
        console.error("❌ Startup failed:", err.message);
        process.exit(1);
    }
})();

module.exports = app;
