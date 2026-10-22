-- REGOČ Message Queue Schema
-- SQLite database for inter-agent communication
-- Location: ~/.claude/regoc/messages.db (PERSISTENT!)

-- Enable WAL mode for better concurrency
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Messages table - core message queue
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    content TEXT NOT NULL,
    message_type TEXT DEFAULT 'text',  -- text, voice, upgrade, command, relay
    priority INTEGER DEFAULT 5,         -- 1=critical, 5=normal, 10=low
    status TEXT DEFAULT 'pending',      -- pending, processing, completed, failed, expired
    chat_id INTEGER,                    -- Telegram chat ID for relay messages
    voice_relay BOOLEAN DEFAULT FALSE,  -- Should response be spoken?
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME,
    expires_at DATETIME,
    response TEXT,
    error TEXT,
    metadata TEXT  -- JSON for additional data
);

-- Agent status table - heartbeat and status tracking
CREATE TABLE IF NOT EXISTS agent_status (
    agent_id TEXT PRIMARY KEY,
    status TEXT DEFAULT 'offline',      -- online, offline, busy
    last_heartbeat DATETIME,
    current_task TEXT,
    pid INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Event log table - audit trail
CREATE TABLE IF NOT EXISTS event_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,           -- message_sent, message_received, agent_online, etc.
    agent_id TEXT,
    message_id TEXT,
    details TEXT,                       -- JSON
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Telegram users table - user tracking
CREATE TABLE IF NOT EXISTS telegram_users (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    is_admin BOOLEAN DEFAULT FALSE,
    last_seen DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON messages(to_agent, status);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_priority ON messages(priority, created_at);
CREATE INDEX IF NOT EXISTS idx_event_log_type ON event_log(event_type);
CREATE INDEX IF NOT EXISTS idx_event_log_agent ON event_log(agent_id);

-- Trigger to update updated_at timestamp
CREATE TRIGGER IF NOT EXISTS messages_updated_at
    AFTER UPDATE ON messages
BEGIN
    UPDATE messages SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS agent_status_updated_at
    AFTER UPDATE ON agent_status
BEGIN
    UPDATE agent_status SET updated_at = CURRENT_TIMESTAMP WHERE agent_id = NEW.agent_id;
END;
