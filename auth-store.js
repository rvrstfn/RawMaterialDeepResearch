#!/usr/bin/env node
"use strict";

const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const DEFAULT_DB_PATH = path.join(__dirname, ".auth.db");
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 30 * 24 * 60 * 60 * 1000);

function nowIso() {
  return new Date().toISOString();
}

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

function passwordHash(password, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function passwordVerify(password, encoded) {
  if (!encoded || typeof encoded !== "string") return false;
  const parts = encoded.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "base64");
  const expected = Buffer.from(parts[2], "base64");
  const actual = crypto.scryptSync(password, salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

class AuthStore {
  constructor(dbPath = DEFAULT_DB_PATH) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();
    this.ensureBootstrapAdmin();
    this.deleteExpiredSessions();
  }

  initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_threads (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        PRIMARY KEY (user_id, thread_id)
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_user_threads_user_last_used ON user_threads(user_id, last_used_at DESC);
    `);
  }

  ensureBootstrapAdmin() {
    const row = this.db.prepare("SELECT COUNT(*) as n FROM users WHERE role = 'admin'").get();
    if (row && Number(row.n) > 0) return;

    const envUser = String(process.env.ADMIN_USERNAME || "").trim();
    const envPass = String(process.env.ADMIN_PASSWORD || "");
    if (envUser && envPass) {
      this.createUser({
        username: envUser,
        password: envPass,
        role: "admin",
      });
      process.stdout.write(`[auth] bootstrap admin created from env: ${normalizeUsername(envUser)}\n`);
      return;
    }

    const fallbackUser = "admin";
    const fallbackPass = crypto.randomBytes(12).toString("base64url");
    this.createUser({
      username: fallbackUser,
      password: fallbackPass,
      role: "admin",
    });
    process.stdout.write(`[auth] bootstrap admin created. username=admin password=${fallbackPass}\n`);
  }

  deleteExpiredSessions() {
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso());
  }

  createUser({ username, password, role = "user" }) {
    const normalized = normalizeUsername(username);
    if (!normalized) throw new Error("username is required");
    if (!password || String(password).length < 8) {
      throw new Error("password must be at least 8 characters");
    }
    const safeRole = role === "admin" ? "admin" : "user";
    const createdAt = nowIso();
    const encoded = passwordHash(String(password));
    const stmt = this.db.prepare(`
      INSERT INTO users (username, password_hash, role, created_at)
      VALUES (?, ?, ?, ?)
    `);
    try {
      const info = stmt.run(normalized, encoded, safeRole, createdAt);
      return this.getUserById(info.lastInsertRowid);
    } catch (err) {
      if (String(err && err.message || "").includes("UNIQUE")) {
        throw new Error("username already exists");
      }
      throw err;
    }
  }

  getUserById(userId) {
    return this.db.prepare(`
      SELECT id, username, role, created_at
      FROM users
      WHERE id = ?
    `).get(userId) || null;
  }

  listUsers() {
    return this.db.prepare(`
      SELECT id, username, role, created_at
      FROM users
      ORDER BY id ASC
    `).all();
  }

  setUserPassword(userId, password) {
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) throw new Error("invalid user id");
    if (!password || String(password).length < 8) {
      throw new Error("password must be at least 8 characters");
    }
    const encoded = passwordHash(String(password));
    const info = this.db.prepare(`
      UPDATE users
      SET password_hash = ?
      WHERE id = ?
    `).run(encoded, id);
    if (!info || info.changes < 1) throw new Error("user not found");
    return this.getUserById(id);
  }

  authenticate(username, password) {
    const normalized = normalizeUsername(username);
    if (!normalized || !password) return null;
    const row = this.db.prepare(`
      SELECT id, username, role, password_hash, created_at
      FROM users
      WHERE username = ?
    `).get(normalized);
    if (!row) return null;
    if (!passwordVerify(String(password), row.password_hash)) return null;
    return {
      id: row.id,
      username: row.username,
      role: row.role,
      created_at: row.created_at,
    };
  }

  createSession(userId) {
    const token = crypto.randomBytes(32).toString("hex");
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    this.db.prepare(`
      INSERT INTO sessions (token, user_id, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(token, userId, createdAt, expiresAt);
    return { token, expiresAt };
  }

  getSession(token) {
    if (!token || typeof token !== "string") return null;
    this.deleteExpiredSessions();
    const row = this.db.prepare(`
      SELECT s.token, s.expires_at, u.id as user_id, u.username, u.role
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = ?
    `).get(token);
    if (!row) return null;
    return {
      token: row.token,
      expiresAt: row.expires_at,
      user: {
        id: row.user_id,
        username: row.username,
        role: row.role,
      },
    };
  }

  deleteSession(token) {
    if (!token) return;
    this.db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  }

  touchUserThread(userId, threadId) {
    if (!userId || !threadId) return;
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO user_threads (user_id, thread_id, created_at, last_used_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, thread_id)
      DO UPDATE SET last_used_at = excluded.last_used_at
    `).run(userId, threadId, now, now);
  }

  userOwnsThread(userId, threadId) {
    if (!userId || !threadId) return false;
    const row = this.db.prepare(`
      SELECT 1 as ok
      FROM user_threads
      WHERE user_id = ? AND thread_id = ?
      LIMIT 1
    `).get(userId, threadId);
    return Boolean(row && row.ok);
  }

  listUserThreads(userId) {
    if (!userId) return [];
    return this.db.prepare(`
      SELECT thread_id, created_at, last_used_at
      FROM user_threads
      WHERE user_id = ?
      ORDER BY last_used_at DESC
    `).all(userId);
  }
}

module.exports = {
  AuthStore,
  SESSION_TTL_MS,
};
