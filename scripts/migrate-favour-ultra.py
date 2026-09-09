import argparse
import json
import shutil
import sqlite3
from datetime import datetime
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--data-dir', required=True)
    parser.add_argument('--owner-id', default='')
    # 运行时共享会话键 = 宿主垫片平台 id（_PLATFORM.id = 'aiocqhttp'，
    # 对齐上游 QQ 适配器命名）。插件全局模式按 unified_msg_origin 的
    # 平台段（origin.split(':')[0]）精确查找。桥接的 'qq:...' 只出现在
    # 会话段里，不参与键计算。
    parser.add_argument('--session-key', default='aiocqhttp')
    args = parser.parse_args()

    source = Path(args.source).resolve()
    data_dir = Path(args.data_dir).resolve()
    marker = data_dir / 'migration-v1.json'
    db_path = data_dir / 'favour.db'
    if marker.exists() or db_path.exists() and db_path.stat().st_size > 0:
        raise SystemExit('migration already completed; refusing to rerun')

    raw = json.loads(source.read_text(encoding='utf-8'))
    users = raw.get('users', {}) if isinstance(raw, dict) else {}
    data_dir.mkdir(parents=True, exist_ok=True)
    snapshot = source.with_name(source.name + '.favour-ultra-before-migration')
    shutil.copy2(source, snapshot)

    now = datetime.now().isoformat(sep=' ')
    records = []
    for uid, entry in users.items():
        if str(uid) == str(args.owner_id) or entry.get('is_bot'):
            continue
        original = entry.get('affection', 0)
        try:
            numeric = float(original)
        except (TypeError, ValueError):
            numeric = 0
        favour = max(-200, min(149, round(numeric)))
        records.append((str(uid), args.session_key, favour, '', 0,
                        str(entry.get('nickname') or entry.get('name') or ''), now, now, now))
    # 主人行与群友行同键（运行时共享会话键）：查询命令按该键精确查找，
    # ensure_owner_records 也以同键重建，三处一致。
    if args.owner_id:
        records.append((str(args.owner_id), args.session_key, 1000, '亲密', 1, '主人', now, now, now))

    with sqlite3.connect(db_path) as db:
        db.execute('''CREATE TABLE favour_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id VARCHAR(128) NOT NULL,
          session_id VARCHAR(256) NOT NULL DEFAULT 'global',
          favour INTEGER NOT NULL DEFAULT 0,
          relationship VARCHAR(256) NOT NULL DEFAULT '',
          is_unique BOOLEAN NOT NULL DEFAULT 0,
          username VARCHAR(128) NOT NULL DEFAULT '',
          created_at DATETIME,
          updated_at DATETIME,
          last_interaction DATETIME
        )''')
        db.execute('CREATE INDEX ix_favour_records_user_id ON favour_records(user_id)')
        db.execute('CREATE INDEX ix_favour_records_session_id ON favour_records(session_id)')
        db.executemany('''INSERT INTO favour_records
          (user_id, session_id, favour, relationship, is_unique, username,
           created_at, updated_at, last_interaction)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)''', records)
        db.commit()

    report = data_dir / 'migration-report.json'
    report.write_text(json.dumps({
        'source': str(source), 'snapshot': str(snapshot),
        'target': str(db_path), 'imported': len(records),
        'sessionKey': args.session_key,
        'records': [
            {'user_id': row[0], 'favour': row[2], 'relationship': row[3],
             'is_unique': bool(row[4])}
            for row in records
        ],
    }, ensure_ascii=False, indent=2), encoding='utf-8')
    marker.write_text(json.dumps({
        'source': str(source), 'snapshot': str(snapshot),
        'target': str(db_path), 'report': str(report),
        'sessionKey': args.session_key,
        'completedAt': datetime.now().isoformat(),
    }, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'ok': True, 'target': str(db_path), 'imported': len(records)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
