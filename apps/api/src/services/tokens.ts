import { SignJWT, importPKCS8, importSPKI, jwtVerify, type JWTPayload, type KeyLike } from 'jose';
import type { UserId, WorkspaceId } from '@relayd/types';
import { AppError } from '@relayd/types';

/**
 * Access tokens, per docs/06 section 15.
 *
 * RS256 with a `kid`, 15 minutes, claims sub / sid / wsIds / ver. Asymmetric
 * rather than HS256 so that a service which only needs to VERIFY a token
 * never has to hold the key that can MINT one.
 */

const ALGORITHM = 'RS256';
const ISSUER = 'relayd';
const AUDIENCE = 'relayd-api';

export interface AccessTokenClaims {
  /** User id. */
  sub: UserId;
  /** Session id, so a single session can be revoked without touching others. */
  sid: string;
  /** Workspaces the user belongs to at issue time. */
  wsIds: WorkspaceId[];
  /**
   * Session version. Compared against a per-user counter that is bumped on
   * password change, role change or MFA change, so a 15-minute token window
   * is not a 15-minute privilege window (docs/06 s15).
   */
  ver: number;
}

export interface TokenServiceOptions {
  privateKeyPem: string;
  publicKeyPem: string;
  keyId: string;
  accessTokenTtlSeconds: number;
}

export class TokenService {
  #privateKey: KeyLike | undefined;
  #publicKey: KeyLike | undefined;

  constructor(private readonly options: TokenServiceOptions) {}

  /**
   * Keys are imported once and cached. Importing is not free, and this runs
   * on every login and every refresh.
   */
  async #private(): Promise<KeyLike> {
    this.#privateKey ??= await importPKCS8(this.options.privateKeyPem, ALGORITHM);
    return this.#privateKey;
  }

  async #public(): Promise<KeyLike> {
    this.#publicKey ??= await importSPKI(this.options.publicKeyPem, ALGORITHM);
    return this.#publicKey;
  }

  async issueAccessToken(claims: AccessTokenClaims): Promise<string> {
    const now = Math.floor(Date.now() / 1000);

    return new SignJWT({
      sid: claims.sid,
      wsIds: claims.wsIds,
      ver: claims.ver,
    })
      .setProtectedHeader({ alg: ALGORITHM, kid: this.options.keyId })
      .setSubject(claims.sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + this.options.accessTokenTtlSeconds)
      .sign(await this.#private());
  }

  /**
   * Verifies signature, issuer, audience and expiry.
   *
   * Every failure — expired, wrong signature, malformed, wrong audience —
   * becomes the same 401. Distinguishing them for the caller would tell an
   * attacker which part of a forged token to fix next.
   */
  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, await this.#public(), {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: [ALGORITHM],
      });
      payload = result.payload;
    } catch {
      throw new AppError('token_expired', 'Access token is not valid', 401);
    }

    const sub = payload.sub;
    const sid = payload['sid'];
    const wsIds = payload['wsIds'];
    const ver = payload['ver'];

    if (
      typeof sub !== 'string' ||
      typeof sid !== 'string' ||
      typeof ver !== 'number' ||
      !Array.isArray(wsIds) ||
      !wsIds.every((id): id is string => typeof id === 'string')
    ) {
      throw new AppError('unauthenticated', 'Access token is malformed', 401);
    }

    return {
      sub: sub as UserId,
      sid,
      wsIds: wsIds as WorkspaceId[],
      ver,
    };
  }
}
