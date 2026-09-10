import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, copyFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Candidate, CandidateResult } from '../toolset/candidate_result.js';

export class CandidateDatabase {
  private db: DatabaseSync;
  constructor(public directory: string) {
    mkdirSync(join(directory, 'resumes'), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'candidates.sqlite'));
    chmodSync(join(directory, 'candidates.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY, identity_key TEXT UNIQUE, name TEXT NOT NULL,
        payload TEXT NOT NULL, source TEXT NOT NULL, context TEXT NOT NULL, first_seen TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS observations(id INTEGER PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidates(id), payload TEXT NOT NULL, context TEXT NOT NULL, seen_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS resume_failures(candidate_id TEXT PRIMARY KEY REFERENCES candidates(id), reason TEXT NOT NULL, code TEXT NOT NULL, failed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS resumes(id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidates(id), created_at TEXT NOT NULL);
    `);
  }
  saveList(result: CandidateResult) {
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const candidates = result.candidates.map(candidate => {
        // 无平台 ID 的记录按独立观察保存，绝不凭姓名合并不同的人。
        const key = candidate.platformId ? `${result.source}:${candidate.platformId}` : null;
        const existing = key ? this.db.prepare('SELECT id FROM candidates WHERE identity_key=?').get(key) : undefined;
        const id = existing ? String(existing.id) : randomUUID();
        const payload = JSON.stringify(candidate);
        this.db.prepare(`INSERT INTO candidates VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
          name=excluded.name,payload=excluded.payload,source=excluded.source,context=excluded.context,updated_at=excluded.updated_at`)
          .run(id, key, candidate.name, payload, result.source, result.context, now, now);
        this.db.prepare('INSERT INTO observations(candidate_id,payload,context,seen_at) VALUES(?,?,?,?)').run(id,payload,result.context,now);
        return { ...candidate, localId: id };
      });
      this.db.exec('COMMIT');
      return { ...result, candidates };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  hasResume(source: string, platformId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM candidates c JOIN resumes r ON r.candidate_id=c.id WHERE c.identity_key=? LIMIT 1`).get(`${source}:${platformId}`));
  }
  saveResume(candidateId: string, imagePath: string) {
    if (!this.db.prepare('SELECT id FROM candidates WHERE id=?').get(candidateId)) throw new Error('本地候选人不存在，无法保存简历。');
    const id = randomUUID();
    copyFileSync(imagePath, join(this.directory,'resumes',id+'.png'));
    chmodSync(join(this.directory,'resumes',id+'.png'),0o600);
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO resumes VALUES(?,?,?)').run(id,candidateId,now);
    this.db.prepare('UPDATE candidates SET updated_at=? WHERE id=?').run(now,candidateId);
    this.db.prepare('DELETE FROM resume_failures WHERE candidate_id=?').run(candidateId);
    return { imageUrl: `/api/local/resume/${id}`, resumeUpdatedAt: now };
  }
  saveResumeFailure(candidateId: string, reason: string, code = 'RESUME_FAILED') {
    this.db.prepare(`INSERT INTO resume_failures VALUES(?,?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET
      reason=excluded.reason,code=excluded.code,failed_at=excluded.failed_at`).run(candidateId,reason,code,new Date().toISOString());
  }
  list(query: string, offset = 0) {
    const where = 'WHERE instr(name,?)>0 OR instr(payload,?)>0';
    const count = Number(this.db.prepare(`SELECT count(*) n FROM candidates ${where}`).get(query,query)!.n);
    const rows = this.db.prepare(`SELECT *, (SELECT id FROM resumes WHERE candidate_id=candidates.id ORDER BY created_at DESC,rowid DESC LIMIT 1) resume_id,
      (SELECT max(created_at) FROM resumes WHERE candidate_id=candidates.id) resume_time FROM candidates ${where} ORDER BY updated_at DESC,id LIMIT 100 OFFSET ?`).all(query,query,offset);
    return { source:'local', context:`本地保存 ${count} 位候选人`, total:count, offset, candidates: rows.map(row => ({
      ...JSON.parse(String(row.payload)) as Candidate, localId:row.id, source:row.source, context:row.context,
      resumeFailure: this.db.prepare('SELECT reason,code,failed_at AS failedAt FROM resume_failures WHERE candidate_id=?').get(row.id) ?? null,
      identityConfirmed: row.identity_key !== null, updatedAt:row.updated_at, firstSeen:row.first_seen,
      imageUrl:row.resume_id ? `/api/local/resume/${row.resume_id}` : null, resumeUpdatedAt:row.resume_time,
    })) };
  }
  syncCandidates() {
    const rows = this.db.prepare(`SELECT id,identity_key,payload,
      (SELECT id FROM resumes WHERE candidate_id=candidates.id ORDER BY created_at DESC,rowid DESC LIMIT 1) resume_id
      FROM candidates ORDER BY id`).all();
    return rows.map(row => ({...JSON.parse(String(row.payload)) as Candidate,
      syncKey: row.identity_key === null ? `local:${row.id}` : String(row.identity_key),
      resumePath: row.resume_id ? join(this.directory,'resumes',String(row.resume_id)+'.png') : null}));
  }
  resumePath(id: string) {
    if (!this.db.prepare('SELECT id FROM resumes WHERE id=?').get(id)) return null;
    return join(this.directory,'resumes',id+'.png');
  }
  close() { this.db.close(); }
}
