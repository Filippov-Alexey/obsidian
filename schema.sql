-- =====================================================
-- Second Brain — MySQL schema
-- =====================================================

CREATE DATABASE IF NOT EXISTS secondbrain
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE secondbrain;

-- ------------------------------------------------------
-- 3.1 Nodes (folders & notes) — self-referencing tree
-- ------------------------------------------------------
CREATE TABLE IF NOT EXISTS nodes (
  id          INT           NOT NULL AUTO_INCREMENT,
  parent_id   INT           NULL,
  title       VARCHAR(255)  NOT NULL,
  content     LONGTEXT      NULL,
  is_folder   TINYINT(1)    NOT NULL DEFAULT 0,
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
                                   ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_nodes_parent
    FOREIGN KEY (parent_id) REFERENCES nodes (id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Unique per (parent, title, type) to avoid duplicates inside a folder
CREATE UNIQUE INDEX ux_nodes_parent_title_type
  ON nodes (parent_id, title, is_folder);

-- Fast title search for wiki-link resolution
CREATE INDEX ix_nodes_title ON nodes (title);

-- ------------------------------------------------------
-- 3.2 Wiki-links (directed)
-- ------------------------------------------------------
CREATE TABLE IF NOT EXISTS links (
  id         INT NOT NULL AUTO_INCREMENT,
  source_id  INT NOT NULL,
  target_id  INT NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_links_source
    FOREIGN KEY (source_id) REFERENCES nodes (id) ON DELETE CASCADE,
  CONSTRAINT fk_links_target
    FOREIGN KEY (target_id) REFERENCES nodes (id) ON DELETE CASCADE,
  UNIQUE KEY ux_links_source_target (source_id, target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX ix_links_target ON links (target_id);

-- ------------------------------------------------------
-- 3.3 Tabs session (workspace restore)
-- ------------------------------------------------------
CREATE TABLE IF NOT EXISTS tabs_session (
  id             INT NOT NULL AUTO_INCREMENT,
  node_id        INT NOT NULL,
  position_order INT NOT NULL,
  is_active      TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  CONSTRAINT fk_tabs_node
    FOREIGN KEY (node_id) REFERENCES nodes (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One active tab at a time (we enforce this in app logic too).
