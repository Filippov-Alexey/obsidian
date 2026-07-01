"""
Second Brain — Flask backend
----------------------------
Стартовая точка:  python app.py
База инициализируется автоматически, если таблиц нет.
"""
import json
import os
import re
import io
import zipfile
from datetime import datetime
import pymysql
from flask import Flask, jsonify, request, send_from_directory, render_template, send_file

# ---------------------------------------------------------------- config
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(BASE_DIR, "config.json"), "r", encoding="utf-8") as f:
    CONFIG = json.load(f)
    print(CONFIG)

app = Flask(
    __name__,
    static_folder=os.path.join(BASE_DIR, "static"),
    template_folder=os.path.join(BASE_DIR, "templates"),
)

# ---------------------------------------------------------------- DB

def ensure_schema():
    """Create tables on first run (without clobbering data)."""
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS nodes (
              id          INT NOT NULL AUTO_INCREMENT,
              parent_id   INT NULL,
              title       VARCHAR(255) NOT NULL,
              content     LONGTEXT NULL,
              is_folder   TINYINT(1) NOT NULL DEFAULT 0,
              created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                                       ON UPDATE CURRENT_TIMESTAMP,
              PRIMARY KEY (id),
              CONSTRAINT fk_nodes_parent FOREIGN KEY (parent_id)
                REFERENCES nodes(id) ON DELETE CASCADE ON UPDATE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
            """
        )
        cur.execute("SELECT COUNT(*) AS c FROM information_schema.statistics "
                    "WHERE table_schema = DATABASE() AND table_name='nodes' "
                    "AND index_name='ux_nodes_parent_title_type'")
        if cur.fetchone()["c"] == 0:
            cur.execute("ALTER TABLE nodes ADD UNIQUE INDEX "
                        "ux_nodes_parent_title_type (parent_id, title, is_folder)")
        cur.execute("SELECT COUNT(*) AS c FROM information_schema.statistics "
                    "WHERE table_schema = DATABASE() AND table_name='nodes' "
                    "AND index_name='ix_nodes_title'")
        if cur.fetchone()["c"] == 0:
            cur.execute("ALTER TABLE nodes ADD INDEX ix_nodes_title (title)")

        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS links (
              id INT NOT NULL AUTO_INCREMENT,
              source_id INT NOT NULL,
              target_id INT NOT NULL,
              PRIMARY KEY (id),
              CONSTRAINT fk_links_source FOREIGN KEY (source_id)
                REFERENCES nodes(id) ON DELETE CASCADE,
              CONSTRAINT fk_links_target FOREIGN KEY (target_id)
                REFERENCES nodes(id) ON DELETE CASCADE,
              UNIQUE KEY ux_links_source_target (source_id, target_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS tabs_session (
              id INT NOT NULL AUTO_INCREMENT,
              node_id INT NOT NULL,
              position_order INT NOT NULL,
              is_active TINYINT(1) NOT NULL DEFAULT 0,
              PRIMARY KEY (id),
              CONSTRAINT fk_tabs_node FOREIGN KEY (node_id)
                REFERENCES nodes(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
            """
        )
    conn.close()


# ---------------------------------------------------------------- wiki-link parser
WIKI_RE = re.compile(r"\[\[([^\[\]\n|]+?)(?:\|([^\[\]\n]+?))?\]\]")


def extract_wikilinks(content: str):
    if not content:
        return []
    out = []
    for m in WIKI_RE.finditer(content):
        out.append({
            "target_title": m.group(1).strip(),
            "alias": (m.group(2) or "").strip(),
        })
    return out


def regenerate_links(cur, node_id: int):
    """Rebuild links table for a given source node."""
    cur.execute("SELECT content, is_folder FROM nodes WHERE id=%s", (node_id,))
    row = cur.fetchone()
    cur.execute("DELETE FROM links WHERE source_id=%s", (node_id,))
    if not row or row["is_folder"] or not row["content"]:
        return
    targets = {}
    for w in extract_wikilinks(row["content"]):
        t = w["target_title"]
        cur.execute("SELECT id FROM nodes WHERE is_folder=0 AND LOWER(title)=LOWER(%s) LIMIT 1", (t,))
        r = cur.fetchone()
        if r and r["id"] != node_id:
            targets[r["id"]] = True
    for tid in targets:
        cur.execute(
            "INSERT IGNORE INTO links (source_id, target_id) VALUES (%s, %s)",
            (node_id, tid),
        )


def rename_and_update_refs(cur, node_id: int, new_title: str):
    """
    При переименовании заметки — заменить [[Старое]] на [[Новый]] во всех
    других заметках и пересчитать таблицу links.
    """
    cur.execute("SELECT title, is_folder FROM nodes WHERE id=%s", (node_id,))
    row = cur.fetchone()
    if not row or row["is_folder"]:
        return
    old_title = row["title"]
    if old_title == new_title:
        return
    cur.execute("UPDATE nodes SET title=%s WHERE id=%s", (new_title, node_id))

    pattern = re.compile(
        r"\[\[" + re.escape(old_title) + r"(\|[^\[\]\n]*?)?\]\]",
        re.IGNORECASE,
    )
    cur.execute("SELECT id, content FROM nodes WHERE is_folder=0 AND id<>%s", (node_id,))
    for n in cur.fetchall():
        if not n["content"]:
            continue
        if not pattern.search(n["content"]):
            continue
        new_content = pattern.sub(
            lambda m: "[[" + new_title + (m.group(1) or "") + "]]",
            n["content"],
        )
        cur.execute("UPDATE nodes SET content=%s WHERE id=%s", (new_content, n["id"]))
        regenerate_links(cur, n["id"])

    regenerate_links(cur, node_id)


# ---------------------------------------------------------------- helpers
def get_descendants(cur, node_id):
    ids = [node_id]
    stack = [node_id]
    while stack:
        pid = stack.pop()
        cur.execute("SELECT id FROM nodes WHERE parent_id=%s", (pid,))
        for r in cur.fetchall():
            ids.append(r["id"])
            stack.append(r["id"])
    return ids


def build_tree(cur, parent_id=None):
    cur.execute(
        "SELECT * FROM nodes WHERE parent_id <=> %s "
        "ORDER BY is_folder DESC, title ASC",
        (parent_id,),
    )
    out = []
    for row in cur.fetchall():
        node = dict(row)
        node["children"] = build_tree(cur, row["id"])
        out.append(node)
    return out


# ---------------------------------------------------------------- ROUTES
@app.route("/")
def index():
    return render_template(
        "index.html",
        hotkeys=CONFIG["hotkeys"],
        theme=CONFIG.get("theme", "dark"),
    )

FORBIDDEN_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def safe_filename(title):
    """Возвращает безопасное имя файла (без разделителей путей и спецсимволов)."""
    name = FORBIDDEN_CHARS.sub('_', title).strip().strip('.')
    return name or 'untitled'
def full_folder_path(cur, node_id, memo=None):
    """Полный путь папки для узла (список заголовков от корня)."""
    if memo is None:
        memo = {}
    if node_id is None:
        return []
    if node_id in memo:
        return memo[node_id]
    cur.execute("SELECT id, parent_id, title FROM nodes WHERE id=%s", (node_id,))
    n = cur.fetchone()
    if not n:
        memo[node_id] = []
        return []
    parent_path = full_folder_path(cur, n["parent_id"], memo)
    memo[node_id] = parent_path + [safe_filename(n["title"])]
    return memo[node_id]

@app.get("/api/export")
def api_export():
    """Экспортировать всё хранилище в zip-архив:
       - папки = каталоги
       - заметки = <title>.md
       - meta.json = метаданные (связи, даты, id)
       - session.json = состояние вкладок
    """
    conn = get_conn()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM nodes ORDER BY id")
            all_nodes = cur.fetchall()
            cur.execute("SELECT source_id, target_id FROM links")
            all_links = cur.fetchall()
            cur.execute("SELECT node_id, position_order, is_active FROM tabs_session ORDER BY position_order")
            session = cur.fetchall()

            used_names = {}  # (parent_id) -> { filename: id }
            memo_paths = {}

            for n in all_nodes:
                if n["is_folder"]:
                    continue
                folder_parts = full_folder_path(cur, n["parent_id"], memo_paths)
                base = safe_filename(n["title"])
                fname = base + '.md'
                key = (n["parent_id"], 'f')
                used_names.setdefault(key, {})
                # ensure unique filename within folder
                if fname in used_names[key] and used_names[key][fname] != n["id"]:
                    i = 2
                    stem = base
                    while True:
                        candidate = f"{stem} ({i}).md"
                        if candidate not in used_names[key]:
                            fname = candidate
                            break
                        i += 1
                used_names[key][fname] = n["id"]

                path = '/'.join(folder_parts + [fname])
                content = n["content"] or ''
                info = zipfile.ZipInfo(path)
                info.compress_type = zipfile.ZIP_DEFLATED
                # preserve timestamps
                if n.get("updated_at"):
                    dt = n["updated_at"]
                    if isinstance(dt, datetime):
                        info.date_time = (dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second)
                zf.writestr(info, content)

            # Write folder structure marker (empty dirs are lost in zip; record them)
            empty_folders = []
            for n in all_nodes:
                if n["is_folder"]:
                    cur.execute("SELECT COUNT(*) AS c FROM nodes WHERE parent_id=%s", (n["id"],))
                    if cur.fetchone()["c"] == 0:
                        parts = full_folder_path(cur, n["id"], memo_paths)
                        empty_folders.append('/'.join(parts) + '/')
            for d in empty_folders:
                zf.writestr(d, '')

            meta = {
                "version": 1,
                "exported_at": datetime.utcnow().isoformat() + 'Z',
                "nodes": [
                    {
                        "id": n["id"],
                        "parent_id": n["parent_id"],
                        "title": n["title"],
                        "is_folder": bool(n["is_folder"]),
                        "created_at": str(n["created_at"]) if n.get("created_at") else None,
                        "updated_at": str(n["updated_at"]) if n.get("updated_at") else None,
                    }
                    for n in all_nodes
                ],
                "links": [
                    {"source_id": l["source_id"], "target_id": l["target_id"]}
                    for l in all_links
                ],
            }
            zf.writestr('meta.json', json.dumps(meta, ensure_ascii=False, indent=2))
            zf.writestr('session.json',
                        json.dumps(session, ensure_ascii=False, indent=2, default=str))
    conn.close()
    buf.seek(0)
    fname = 'secondbrain-' + datetime.utcnow().strftime('%Y%m%d-%H%M%S') + '.zip'
    return send_file(
        buf,
        mimetype='application/zip',
        as_attachment=True,
        download_name=fname,
    )


def _next_id(cur):
    cur.execute("SELECT COALESCE(MAX(id), 0) + 1 AS n FROM nodes")
    return cur.fetchone()["n"]


@app.post("/api/import")
def api_import():
    """Импорт zip-архива. Тело запроса — файл (multipart/form-data).
       Стратегия: сложение в текущее хранилище (merge).
       - meta.json присутствует — импортируем по ID с пере-map-кой при коллизиях
         (т.е. добавляем как новые записи, сохраняя связи между импортируемыми).
       - meta.json отсутствует — импортируем только по структуре папок и md-файлам.
       - Если `mode=replace` передан (поле формы) — БД предварительно очищается.
    """
    if 'file' not in request.files:
        return jsonify({"error": "file field required"}), 400
    f = request.files['file']
    if not f.filename.lower().endswith('.zip'):
        return jsonify({"error": "zip archive required"}), 400
    mode = request.form.get('mode', 'merge')  # 'merge' | 'replace'

    data = f.read()
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        return jsonify({"error": "bad zip file"}), 400

    conn = get_conn()
    with conn.cursor() as cur:
        if mode == 'replace':
            # очистить всё
            cur.execute("DELETE FROM links")
            cur.execute("DELETE FROM tabs_session")
            cur.execute("DELETE FROM nodes")

        # Читаем meta.json, если есть
        id_map = {}     # old_id -> new_id
        imported_folders = {}  # "/папка/подпапка/" -> new_id
        notes_to_create = []   # list of dicts: {path, title, content, parent_folder}

        meta = None
        if 'meta.json' in zf.namelist():
            try:
                meta = json.loads(zf.read('meta.json').decode('utf-8'))
            except Exception:
                meta = None

        # 1. Сначала создаём папки (из meta или из структуры)
        if meta and isinstance(meta.get('nodes'), list):
            # Сначала папки, затем заметки, чтобы не нарушать FK.
            folders = [n for n in meta['nodes'] if n.get('is_folder')]
            notes = [n for n in meta['nodes'] if not n.get('is_folder')]
            # топологическая сортировка по parent_id (parents first)
            placed = set()
            remaining = list(folders)
            # корневые сначала
            def all_known_parent_ids():
                return set(id_map.keys()) | {None}
            # Простая многопроходная сортировка
            while remaining:
                progress = False
                for fol in list(remaining):
                    if fol.get('parent_id') is None or fol['parent_id'] in placed:
                        old_pid = fol.get('parent_id')
                        new_pid = id_map.get(old_pid) if old_pid is not None else None
                        cur.execute(
                            "INSERT INTO nodes (parent_id, title, content, is_folder) "
                            "VALUES (%s, %s, NULL, 1)",
                            (new_pid, fol['title'])
                        )
                        new_id = cur.lastrowid
                        id_map[fol['id']] = new_id
                        placed.add(fol['id'])
                        remaining.remove(fol)
                        progress = True
                if not progress:
                    # Отельные случаи — подвешиваем в корень
                    for fol in remaining:
                        cur.execute(
                            "INSERT INTO nodes (parent_id, title, content, is_folder) "
                            "VALUES (NULL, %s, NULL, 1)",
                            (fol['title'],)
                        )
                        id_map[fol['id']] = cur.lastrowid
                    remaining = []
                    break

            # Создаём заметки, их содержимое берём из zip по пути (если получится),
            # или из meta? Контент хранится в .md файлах, а не в meta.
            for note in notes:
                old_pid = note.get('parent_id')
                new_pid = id_map.get(old_pid) if old_pid is not None else None
                # Ищем md-файл в зипе, который соответствует этой заметке.
                # Для простоты: если title и parent совпадают — сопоставляем.
                content = ''
                # Путь относительно импортируемой структуры
                cur_path_parts = _resolve_folder_title_path(cur, new_pid) if new_pid else []
                candidate = '/'.join(cur_path_parts + [safe_filename(note['title']) + '.md'])
                if candidate in zf.namelist():
                    try:
                        content = zf.read(candidate).decode('utf-8')
                    except Exception:
                        content = ''
                else:
                    # пробуем без учёта пути по заданному id? fallback: поиск по имени
                    for name in zf.namelist():
                        if name.lower().endswith('.md') and os.path.basename(name) == safe_filename(note['title']) + '.md':
                            try:
                                content = zf.read(name).decode('utf-8')
                            except Exception:
                                content = ''
                            break
                cur.execute(
                    "INSERT INTO nodes (parent_id, title, content, is_folder) "
                    "VALUES (%s, %s, %s, 0)",
                    (new_pid, note['title'], content)
                )
                id_map[note['id']] = cur.lastrowid

            # Связи — с учётом remap
            if isinstance(meta.get('links'), list):
                for l in meta['links']:
                    ns = id_map.get(l.get('source_id'))
                    nt = id_map.get(l.get('target_id'))
                    if ns and nt and ns != nt:
                        cur.execute(
                            "INSERT IGNORE INTO links (source_id, target_id) VALUES (%s, %s)",
                            (ns, nt)
                        )
        else:
            # Нет meta.json — импортируем по структуре файлов
            md_files = [n for n in zf.namelist() if n.lower().endswith('.md') and not n.endswith('/')]
            for entry in zf.namelist():
                if entry.endswith('/'):
                    _ensure_folder_path(cur, entry.rstrip('/').split('/'), imported_folders)
            for md in md_files:
                parts = md.split('/')
                fname = parts[-1]
                title = os.path.splitext(fname)[0]
                folder_parts = parts[:-1]
                parent_id = _ensure_folder_path(cur, folder_parts, imported_folders) if folder_parts else None
                try:
                    content = zf.read(md).decode('utf-8')
                except Exception:
                    content = ''
                # Уникализация названия в папке
                cur.execute(
                    "SELECT id FROM nodes WHERE parent_id <=> %s AND title=%s AND is_folder=0",
                    (parent_id, title)
                )
                exists = cur.fetchone()
                if exists and mode == 'merge':
                    # добавляем как новую с суффиксом
                    i = 2
                    while True:
                        candidate = f"{title} (imported {i})"
                        cur.execute(
                            "SELECT id FROM nodes WHERE parent_id <=> %s AND title=%s AND is_folder=0",
                            (parent_id, candidate)
                        )
                        if not cur.fetchone():
                            title = candidate; break
                        i += 1
                cur.execute(
                    "INSERT INTO nodes (parent_id, title, content, is_folder) VALUES (%s, %s, %s, 0)",
                    (parent_id, title, content)
                )

        # пересчитать links для всех новых (на случай если загрузили файлы без meta)
        cur.execute("SELECT id FROM nodes WHERE is_folder=0")
        for row in cur.fetchall():
            regenerate_links(cur, row["id"])

        # Сессию не импортируем, чтобы не ломать текущую.
    conn.close()
    return jsonify({"ok": True, "mode": mode})


def _resolve_folder_title_path(cur, folder_id):
    """Возвращает список safe-имён папок от корня для заданного folder_id."""
    parts = []
    cur_id = folder_id
    while cur_id is not None:
        cur.execute("SELECT parent_id, title FROM nodes WHERE id=%s", (cur_id,))
        r = cur.fetchone()
        if not r: break
        parts.insert(0, safe_filename(r["title"]))
        cur_id = r["parent_id"]
    return parts


def _ensure_folder_path(cur, parts, imported_folders):
    """Создаёт (если нужно) цепочку папок и возвращает id последней."""
    parent_id = None
    path_so_far = ''
    for seg in parts:
        if not seg: continue
        path_so_far = path_so_far + '/' + seg
        if path_so_far in imported_folders:
            parent_id = imported_folders[path_so_far]
            continue
        seg_safe = seg  # уже безопасно, т.к. из zip-имени
        cur.execute(
            "SELECT id FROM nodes WHERE parent_id <=> %s AND title=%s AND is_folder=1",
            (parent_id, seg_safe)
        )
        r = cur.fetchone()
        if r:
            nid = r['id']
        else:
            cur.execute(
                "INSERT INTO nodes (parent_id, title, content, is_folder) VALUES (%s, %s, NULL, 1)",
                (parent_id, seg_safe)
            )
            nid = cur.lastrowid
        imported_folders[path_so_far] = nid
        parent_id = nid
    return parent_id
# -------------- nodes CRUD
@app.get("/api/nodes")
def api_get_nodes():
    conn = get_conn()
    with conn.cursor() as cur:
        tree = build_tree(cur, None)
    conn.close()
    return jsonify(tree)


def get_conn():
    try:
        return pymysql.connect(
            user='root',
            password='2010_GnitooR-2010',
            database='secondbrain',
            unix_socket='/run/mysqld/mysqld10.sock',
            cursorclass=pymysql.cursors.DictCursor
        )
    except Exception as e:
        print(f"Ошибка при создании соединения: {e}")
        return None

# Допустим, get_conn() определен ранее и возвращает соединение или None

@app.put("/api/nodes/<int:node_id>")
def api_update_node(node_id):
    data = request.get_json(force=True)
    conn = get_conn()
    if not conn:
        return jsonify({"error": "Database connection failed"}), 500
        
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM nodes WHERE id=%s", (node_id,))
            node = cur.fetchone()
            if not node:
                return jsonify({"error": "not found"}), 404

            # Явно проверяем наличие ключа в JSON, чтобы отличать "не передали" от "передали NULL"
            has_parent_key = "parent_id" in data
            new_parent = data.get("parent_id") if has_parent_key else node["parent_id"]
            
            new_title = data.get("title")
            new_content = data.get("content")

            # 1. ОБРАБОТКА ПЕРЕИМЕНОВАНИЯ
            if new_title is not None:
                new_title = new_title.strip()
                if not new_title:
                    return jsonify({"error": "empty title"}), 400
                    
                if new_title != node["title"]:
                    # Проверяем уникальность в целевой папке (учитываем возможное перемещение)
                    cur.execute(
                        "SELECT id FROM nodes WHERE parent_id <=> %s AND title=%s "
                        "AND is_folder=%s AND id <> %s",
                        (new_parent, new_title, node["is_folder"], node_id),
                    )
                    if cur.fetchone():
                        return jsonify({"error": "duplicate title"}), 409
                        
                    if node["is_folder"]:
                        cur.execute("UPDATE nodes SET title=%s WHERE id=%s", (new_title, node_id))
                    else:
                        rename_and_update_refs(cur, node_id, new_title)

            # 2. ОБРАБОТКА ПЕРЕМЕЩЕНИЯ
            if has_parent_key and new_parent != node["parent_id"]:
                if new_parent is not None:
                    # Проверка на перемещение внутрь себя или своего поддерева
                    if new_parent == node_id:
                        return jsonify({"error": "cannot move into itself"}), 400
                    desc = get_descendants(cur, node_id) or []
                    if new_parent in desc:
                        return jsonify({"error": "cannot move into own subtree"}), 400
                        
                cur.execute("UPDATE nodes SET parent_id=%s WHERE id=%s", (new_parent, node_id))

            # 3. ОБРАБОТКА ОБНОВЛЕНИЯ КОНТЕНТА
            if new_content is not None and not node["is_folder"]:
                if new_content != node["content"]:
                    cur.execute(
                        "UPDATE nodes SET content=%s WHERE id=%s",
                        (new_content, node_id),
                    )
                    regenerate_links(cur, node_id)

            # Фиксируем изменения и возвращаем обновленный объект
            conn.commit()
            cur.execute("SELECT * FROM nodes WHERE id=%s", (node_id,))
            updated = cur.fetchone()
            
        return jsonify(updated)
        
    except Exception as e:
        conn.rollback()
        print(f"Ошибка PUT /api/nodes: {e}")
        return jsonify({"error": "Internal server error"}), 500
    finally:
        conn.close()


@app.delete("/api/nodes/<int:node_id>")
def api_delete_node(node_id):
    conn = get_conn()
    if not conn:
        return jsonify({"error": "Database connection failed"}), 500
        
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM nodes WHERE id=%s", (node_id,))
            if not cur.fetchone():
                return jsonify({"error": "not found"}), 404
            
            # Получаем id детей ТОЛЬКО для того, чтобы вернуть их во фронтенд (для UI-эффектов)
            # Вкладки в tabs_session и связи в links удалятся автоматически благодаря ON DELETE CASCADE
            ids = get_descendants(cur, node_id) or []
            if node_id not in ids:
                ids.append(node_id) # Добавляем саму ноду в список удаленных
                
            cur.execute("DELETE FROM nodes WHERE id=%s", (node_id,))
            conn.commit()
            
        return jsonify({"deleted": ids})
        
    except Exception as e:
        conn.rollback()
        print(f"Ошибка DELETE /api/nodes: {e}")
        return jsonify({"error": "Internal server error"}), 500
    finally:
        conn.close()


@app.get("/api/flat")
def api_flat():
    conn = get_conn()
    if not conn:
        return jsonify({"error": "Database connection failed"}), 500
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, title, parent_id, is_folder, created_at, updated_at "
                "FROM nodes ORDER BY title"
            )
            nodes = cur.fetchall()
            cur.execute("SELECT source_id, target_id FROM links")
            links = cur.fetchall()
        return jsonify({"nodes": nodes, "links": links})
    except Exception as e:
        print(f"Ошибка GET /api/flat: {e}")
        return jsonify({"error": "Internal server error"}), 500
    finally:
        conn.close()


@app.get("/api/nodes/<int:node_id>")
def api_get_node(node_id):
    conn = get_conn()
    if not conn:
        return jsonify({"error": "Database connection failed"}), 500
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM nodes WHERE id=%s", (node_id,))
            node = cur.fetchone()
            if not node:
                return jsonify({"error": "not found"}), 404
                
            cur.execute(
                "SELECT n.id, n.title FROM links l "
                "JOIN nodes n ON n.id = l.source_id "
                "WHERE l.target_id=%s ORDER BY n.title",
                (node_id,),
            )
            backlinks = cur.fetchall()
        return jsonify({**node, "backlinks": backlinks})
    except Exception as e:
        print(f"Ошибка GET /api/nodes/<id>: {e}")
        return jsonify({"error": "Internal server error"}), 500
    finally:
        conn.close()


@app.get("/api/session")
def api_get_session():
    conn = get_conn()
    if not conn:
        return jsonify({"error": "Database connection failed"}), 500
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT node_id, position_order, is_active FROM tabs_session "
                        "ORDER BY position_order ASC")
            tabs = cur.fetchall()
        return jsonify(tabs)
    except Exception as e:
        print(f"Ошибка GET /api/session: {e}")
        return jsonify({"error": "Internal server error"}), 500
    finally:
        conn.close()

@app.post("/api/nodes")
def api_create_node():
    data = request.get_json(force=True)
    parent_id = data.get("parent_id")
    title = (data.get("title") or "").strip()
    is_folder = 1 if bool(data.get("is_folder")) else 0
    
    if not title:
        return jsonify({"error": "title required"}), 400
        
    conn = get_conn()
    if not conn:
        return jsonify({"error": "Database connection failed"}), 500

    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id FROM nodes WHERE parent_id <=> %s AND title=%s AND is_folder=%s",
                (parent_id, title, is_folder),
            )
            if cur.fetchone():
                return jsonify({"error": "already exists"}), 409

            cur.execute(
                "INSERT INTO nodes (parent_id, title, content, is_folder) "
                "VALUES (%s, %s, %s, %s)",
                (parent_id, title, None if is_folder else "", is_folder),
            )
            new_id = cur.lastrowid
            
            # Парсим вики-ссылки для новых заметок
            if not is_folder:
                regenerate_links(cur, new_id)
                
            conn.commit() 
            
        return jsonify({"id": new_id}), 201

    except Exception as e:
        conn.rollback() # Откатываем изменения в случае непредвиденной ошибки
        print(f"Ошибка эндпоинта: {e}")
        return jsonify({"error": "Internal server error"}), 500
        
    finally:
        conn.close() 

@app.post("/api/session")
def api_save_session():
    data = request.get_json(force=True)
    tabs = data.get("tabs", [])
    conn = get_conn()
    if not conn:
        return jsonify({"error": "Database connection failed"}), 500
        
    try:
        with conn.cursor() as cur:
            # Очищаем старую сессию в транзакции
            cur.execute("DELETE FROM tabs_session")
            
            if tabs:
                # Оптимизация: вставляем все вкладки одним пакетным запросом (Bulk Insert)
                query = "INSERT INTO tabs_session (node_id, position_order, is_active) VALUES (%s, %s, %s)"
                values = [(t["node_id"], i, 1 if t.get("is_active") else 0) for i, t in enumerate(tabs)]
                cur.executemany(query, values)
                
            conn.commit()
        return jsonify({"ok": True})
        
    except Exception as e:
        conn.rollback()
        print(f"Ошибка POST /api/session: {e}")
        return jsonify({"error": "Internal server error"}), 500
    finally:
        conn.close()


# -------------- config for frontend (hotkeys, theme)
@app.get("/api/config")
def api_config():
    return jsonify({
        "theme": CONFIG.get("theme", "dark"),
        "hotkeys": CONFIG.get("hotkeys", {}),
    })


if __name__ == "__main__":
    ensure_schema()
    app.run(
        host=CONFIG["app"]["host"],
        port=CONFIG["app"]["port"],
        debug=CONFIG["app"]["debug"],
    )
