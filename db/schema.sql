-- Shema baze TaskManagerAI (SQLite, WAL).
-- Stvara se skriptom scripts/init-db.sh; ovo je jedini izvor istine o shemi.

-- table: cost_log
CREATE TABLE cost_log (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        agent_id TEXT NOT NULL,
        task_id TEXT,
        model TEXT NOT NULL,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0
      , cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0, session_id TEXT, turns INTEGER, project_id TEXT);

-- table: execution_queue
CREATE TABLE execution_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  task_type TEXT DEFAULT 'task',
  priority INTEGER NOT NULL,
  queued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  status TEXT DEFAULT 'pending',
  started_at DATETIME,
  completed_at DATETIME,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  error_message TEXT,
  FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- table: knowledge
CREATE TABLE knowledge (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        source TEXT,
        rag_doc_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

-- table: knowledge_relations
CREATE TABLE knowledge_relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_id TEXT NOT NULL REFERENCES knowledge(id),
        to_id TEXT NOT NULL REFERENCES knowledge(id),
        relation_type TEXT NOT NULL,
        weight REAL DEFAULT 1.0,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(from_id, to_id, relation_type)
      );

-- table: project_agents
CREATE TABLE project_agents (
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  role TEXT DEFAULT 'member' CHECK(role IN ('lead', 'member', 'reviewer', 'observer')),
  assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, agent_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- table: project_rag_entries
CREATE TABLE project_rag_entries (
  project_id TEXT NOT NULL,
  rag_collection TEXT NOT NULL,                 -- ChromaDB collection name
  rag_document_id TEXT NOT NULL,                -- Document ID in ChromaDB
  linked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  linked_by TEXT,                               -- Agent who created the link
  PRIMARY KEY (project_id, rag_collection, rag_document_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- table: project_sequence
CREATE TABLE project_sequence (
  id INTEGER PRIMARY KEY CHECK(id = 1),         -- Single row table
  next_id INTEGER DEFAULT 1
);

-- table: project_spec_history
CREATE TABLE project_spec_history (
      id            TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL,
      specification TEXT NOT NULL,
      dispatched_to TEXT NOT NULL,
      task_id       TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

-- table: projects
CREATE TABLE projects (
  id TEXT PRIMARY KEY,                          -- PRJ-001 format
  name TEXT NOT NULL,                           -- Human-readable project name
  description TEXT,                             -- Detailed description (markdown supported)
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'on_hold', 'completed', 'archived')),
  priority INTEGER DEFAULT 3 CHECK(priority BETWEEN 1 AND 5),  -- 1=Critical, 5=Backlog
  lead_agent TEXT,                              -- Primary agent responsible
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  target_date TEXT,                             -- ISO date string for deadline
  tags TEXT DEFAULT '[]',                       -- JSON array of tags
  metadata TEXT DEFAULT '{}'                    -- JSON object for extensibility
, nextcloud_folder_id TEXT, nextcloud_share_url TEXT, specification TEXT DEFAULT '', spec_updated_at TEXT);

-- table: task_history
CREATE TABLE task_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    field TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    changed_by TEXT DEFAULT 'system',
    changed_at TEXT DEFAULT (datetime('now'))
  );

-- table: task_id_seq
CREATE TABLE task_id_seq (
        key        TEXT PRIMARY KEY,
        next_id    INTEGER NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      );

-- table: tasks
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'pending',
  priority INTEGER DEFAULT 3,
  assignee TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT,
  blocked_by TEXT DEFAULT '[]'
, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL, progress_percent INTEGER DEFAULT NULL, nextcloud_folder TEXT DEFAULT NULL, progress_notes TEXT DEFAULT '[]', tags TEXT DEFAULT '[]', result_summary TEXT DEFAULT '', blocks TEXT DEFAULT '[]', started_at TEXT, completed_at TEXT, blocked_reason TEXT DEFAULT '', due_date TEXT, paused INTEGER NOT NULL DEFAULT 0, paused_at TEXT, paused_by TEXT, pause_reason TEXT);

-- index: idx_cost_log_agent
CREATE INDEX idx_cost_log_agent ON cost_log(agent_id);

-- index: idx_cost_log_model
CREATE INDEX idx_cost_log_model ON cost_log(model);

-- index: idx_cost_log_project
CREATE INDEX idx_cost_log_project ON cost_log(project_id);

-- index: idx_cost_log_task
CREATE INDEX idx_cost_log_task ON cost_log(task_id);

-- index: idx_cost_log_timestamp
CREATE INDEX idx_cost_log_timestamp ON cost_log(timestamp);

-- index: idx_project_agents_agent
CREATE INDEX idx_project_agents_agent ON project_agents(agent_id);

-- index: idx_project_agents_project
CREATE INDEX idx_project_agents_project ON project_agents(project_id);

-- index: idx_project_rag_collection
CREATE INDEX idx_project_rag_collection ON project_rag_entries(rag_collection);

-- index: idx_project_rag_project
CREATE INDEX idx_project_rag_project ON project_rag_entries(project_id);

-- index: idx_projects_lead_agent
CREATE INDEX idx_projects_lead_agent ON projects(lead_agent);

-- index: idx_projects_priority
CREATE INDEX idx_projects_priority ON projects(priority);

-- index: idx_projects_status
CREATE INDEX idx_projects_status ON projects(status);

-- index: idx_queue_status
CREATE INDEX idx_queue_status ON execution_queue(status, priority);

-- index: idx_queue_task
CREATE INDEX idx_queue_task ON execution_queue(task_id);

-- index: idx_spec_history_project
CREATE INDEX idx_spec_history_project ON project_spec_history(project_id);

-- index: idx_task_history_changed_at
CREATE INDEX idx_task_history_changed_at ON task_history(changed_at);

-- index: idx_task_history_task
CREATE INDEX idx_task_history_task ON task_history(task_id);

-- index: idx_tasks_assignee
CREATE INDEX idx_tasks_assignee ON tasks(assignee);

-- index: idx_tasks_priority
CREATE INDEX idx_tasks_priority ON tasks(priority);

-- index: idx_tasks_project
CREATE INDEX idx_tasks_project ON tasks(project_id);

-- index: idx_tasks_status
CREATE INDEX idx_tasks_status ON tasks(status);

-- trigger: auto_queue_p1_on_update
CREATE TRIGGER auto_queue_p1_on_update
AFTER UPDATE ON tasks
WHEN NEW.priority = 1
  AND NEW.status = 'pending'
  AND (OLD.priority != 1 OR OLD.status != 'pending')
BEGIN
  -- Only queue if not already queued
  INSERT OR IGNORE INTO execution_queue (task_id, task_type, priority, queued_at)
  SELECT NEW.id, 'task', 1, datetime('now')
  WHERE NOT EXISTS (
    SELECT 1 FROM execution_queue
    WHERE task_id = NEW.id
      AND status IN ('pending', 'processing')
  );
END;

-- trigger: auto_queue_p1_tasks
CREATE TRIGGER auto_queue_p1_tasks
AFTER INSERT ON tasks
WHEN NEW.priority = 1 AND NEW.status = 'pending'
BEGIN
  INSERT INTO execution_queue (task_id, task_type, priority, queued_at)
  VALUES (NEW.id, 'task', 1, datetime('now'));
END;

-- trigger: dequeue_on_complete
CREATE TRIGGER dequeue_on_complete
AFTER UPDATE ON tasks
WHEN NEW.status IN ('completed', 'cancelled')
BEGIN
  UPDATE execution_queue
  SET status = 'completed',
      completed_at = CURRENT_TIMESTAMP
  WHERE task_id = NEW.id
    AND status IN ('pending', 'processing');
END;

-- trigger: projects_updated_at
CREATE TRIGGER projects_updated_at
AFTER UPDATE ON projects
BEGIN
  UPDATE projects
  SET updated_at = CURRENT_TIMESTAMP
  WHERE id = NEW.id;
END;

-- trigger: tasks_updated_at
CREATE TRIGGER tasks_updated_at
AFTER UPDATE ON tasks
BEGIN
  UPDATE tasks
  SET updated_at = CURRENT_TIMESTAMP
  WHERE id = NEW.id;
END;

-- view: v_cost_log
CREATE VIEW v_cost_log AS
SELECT id, timestamp, agent_id, task_id, model,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       session_id, turns, project_id, cost_usd,
       CASE WHEN (COALESCE(cache_read_tokens, 0) + COALESCE(input_tokens, 0)) > 0
            THEN CAST(COALESCE(cache_read_tokens, 0) AS REAL)
                 / (COALESCE(cache_read_tokens, 0) + COALESCE(input_tokens, 0))
            ELSE NULL
       END AS cache_hit_ratio
FROM cost_log;

-- view: v_projects_summary
CREATE VIEW v_projects_summary AS
    SELECT
      p.id,
      p.name,
      p.status,
      p.priority,
      p.lead_agent,
      p.created_at,
      p.updated_at,
      p.target_date,
      p.description,
      p.specification,
      p.spec_updated_at,
      p.tags,
      p.metadata,
      p.nextcloud_folder_id,
      p.nextcloud_share_url,
      (SELECT COUNT(*) FROM project_agents pa WHERE pa.project_id = p.id) as agent_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) as task_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'completed') as completed_task_count,
      ROUND(COALESCE(
        CASE
          WHEN (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) = 0 THEN 0
          ELSE (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status IN ('completed', 'cancelled')) * 100.0 / (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id)
        END
      , 0), 1) as calculated_progress,
      (SELECT COUNT(*) FROM project_rag_entries pre WHERE pre.project_id = p.id) as rag_entry_count
    FROM projects p;
