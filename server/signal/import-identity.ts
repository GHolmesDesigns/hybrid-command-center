import type { Db } from '../db.ts';
import type {
  SignalPostIdentityWorkspace,
  WorkspaceSignalPostAlias,
  WorkspaceSignalPostIdentity,
} from '../domain/signal-post-identity.ts';
import type { SignalPostImportIdentity } from '../../shared/signal-import.ts';

/** The identity snapshot C90 will plan against before and again during confirmation. */
export function readSignalPostIdentityWorkspace(db: Db): SignalPostIdentityWorkspace {
  return {
    posts: db
      .prepare('SELECT id, text, date FROM signal_posts ORDER BY created_at, id')
      .all() as unknown as WorkspaceSignalPostIdentity[],
    aliases: db
      .prepare(
        `SELECT source_namespace namespace, external_id externalId, post_id postId
         FROM signal_post_import_aliases ORDER BY source_namespace, external_id`,
      )
      .all() as unknown as WorkspaceSignalPostAlias[],
  };
}

/**
 * Records a planned identity. Deliberately an INSERT, never an upsert: an established identity
 * cannot be retargeted by a routine import. The caller supplies the transaction and timestamp so
 * this row lands or rolls back with the rest of C90's confirmed import.
 */
export function recordSignalPostImportAlias(
  db: Db,
  identity: SignalPostImportIdentity,
  postId: string,
  createdAt: string,
): void {
  db.prepare(
    `INSERT INTO signal_post_import_aliases(source_namespace,external_id,post_id,created_at)
     VALUES(?,?,?,?)`,
  ).run(identity.namespace, identity.externalId, postId, createdAt);
}
