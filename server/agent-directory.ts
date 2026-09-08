import crypto from 'node:crypto';
import type { Db } from './db.ts';

export const AGENT_PROFILE_NAME_MAX = 80;
export const AGENT_PROFILE_BIO_MAX = 500;
export const AGENT_CAPABILITY_MAX = 80;

export type AgentCapability = { name: string; description: string | null };
export type AgentDirectoryProfile = {
  id: string;
  label: string;
  displayName: string;
  bio: string | null;
  trustLevel: 'UNVERIFIED' | 'VERIFIED';
  availability: 'CURRENT' | 'HISTORICAL' | 'UNKNOWN';
  lastVerifiedAt: string | null;
  lastSeenAt: string | null;
  capabilities: AgentCapability[];
};

type ProfileRow = {
  id: string;
  display_label: string;
  display_name: string;
  bio: string | null;
  trust_level: AgentDirectoryProfile['trustLevel'];
  last_verified_at: string | null;
  last_used_at: string | null;
  capability_name: string | null;
  capability_description: string | null;
};

const availability = (
  lastVerifiedAt: string | null,
  now: number,
): AgentDirectoryProfile['availability'] => {
  if (!lastVerifiedAt) return 'UNKNOWN';
  return now - Date.parse(lastVerifiedAt) <= 15 * 60 * 1000 ? 'CURRENT' : 'HISTORICAL';
};

export function listAgentDirectory(db: Db, now = Date.now()): AgentDirectoryProfile[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.display_label, COALESCE(p.display_name, r.display_label) display_name,
    p.bio, COALESCE(p.trust_level, 'UNVERIFIED') trust_level, p.last_verified_at, r.last_used_at,
    c.name capability_name, c.description capability_description
    FROM agent_registrations r LEFT JOIN agent_profiles p ON p.agent_id=r.id
    LEFT JOIN agent_capabilities c ON c.agent_id=r.id
    ORDER BY display_name COLLATE NOCASE, capability_name COLLATE NOCASE`,
    )
    .all() as ProfileRow[];
  const byId = new Map<string, AgentDirectoryProfile>();
  for (const row of rows) {
    const profile = byId.get(row.id) ?? {
      id: row.id,
      label: row.display_label,
      displayName: row.display_name,
      bio: row.bio,
      trustLevel: row.trust_level,
      availability: availability(row.last_verified_at, now),
      lastVerifiedAt: row.last_verified_at,
      lastSeenAt: row.last_used_at,
      capabilities: [],
    };
    if (row.capability_name)
      profile.capabilities.push({
        name: row.capability_name,
        description: row.capability_description,
      });
    byId.set(row.id, profile);
  }
  return [...byId.values()];
}

export function upsertAgentProfile(
  db: Db,
  agentId: string,
  input: {
    displayName: string;
    bio?: string | null;
    trustLevel?: AgentDirectoryProfile['trustLevel'];
    capabilities: AgentCapability[];
  },
  now = Date.now(),
) {
  const at = new Date(now).toISOString();
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO agent_profiles(agent_id, display_name, bio, trust_level, last_verified_at)
      VALUES(?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET display_name=excluded.display_name,
      bio=excluded.bio, trust_level=excluded.trust_level, last_verified_at=excluded.last_verified_at`,
    ).run(agentId, input.displayName, input.bio ?? null, input.trustLevel ?? 'UNVERIFIED', at);
    db.prepare('DELETE FROM agent_capabilities WHERE agent_id=?').run(agentId);
    const insert = db.prepare(
      'INSERT INTO agent_capabilities(id, agent_id, name, description) VALUES(?,?,?,?)',
    );
    for (const capability of input.capabilities)
      insert.run(crypto.randomUUID(), agentId, capability.name, capability.description ?? null);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
