import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "../errors/app-error.js";

export interface AuthTokenServiceOptions {
  accessSecret: string;
  refreshSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
}

export interface IssueTokenPairInput {
  userId: string;
  githubId: string;
  githubLogin: string;
}

export interface AuthJwtClaims {
  sub: string;
  typ: "access" | "refresh";
  githubId: string;
  githubLogin: string;
  iat: number;
  exp: number;
}

export interface AuthTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshTokenExpiresIn: number;
}

export class AuthTokenService {
  constructor(private readonly options: AuthTokenServiceOptions) {}

  issueTokenPair(input: IssueTokenPairInput): AuthTokenPair {
    const issuedAt = currentUnixTimestamp();
    const accessClaims = this.createClaims(input, "access", issuedAt, this.options.accessTokenTtlSeconds);
    const refreshClaims = this.createClaims(input, "refresh", issuedAt, this.options.refreshTokenTtlSeconds);

    return {
      accessToken: signJwt(accessClaims, this.options.accessSecret),
      refreshToken: signJwt(refreshClaims, this.options.refreshSecret),
      expiresIn: this.options.accessTokenTtlSeconds,
      refreshTokenExpiresIn: this.options.refreshTokenTtlSeconds
    };
  }

  issueTokenPairFromClaims(claims: AuthJwtClaims): AuthTokenPair {
    return this.issueTokenPair({
      userId: claims.sub,
      githubId: claims.githubId,
      githubLogin: claims.githubLogin
    });
  }

  verifyAccessToken(token: string): AuthJwtClaims {
    return this.verifyToken(token, "access", this.options.accessSecret, "无效或已过期的 accessToken");
  }

  verifyRefreshToken(token: string): AuthJwtClaims {
    return this.verifyToken(token, "refresh", this.options.refreshSecret, "无效或已过期的 refreshToken");
  }

  private createClaims(
    input: IssueTokenPairInput,
    tokenType: AuthJwtClaims["typ"],
    issuedAt: number,
    ttlSeconds: number
  ): AuthJwtClaims {
    return {
      sub: input.userId,
      typ: tokenType,
      githubId: input.githubId,
      githubLogin: input.githubLogin,
      iat: issuedAt,
      exp: issuedAt + ttlSeconds
    };
  }

  private verifyToken(
    token: string,
    expectedType: AuthJwtClaims["typ"],
    secret: string,
    errorMessage: string
  ): AuthJwtClaims {
    try {
      const claims = verifyJwt(token, secret);

      if (claims.typ !== expectedType || claims.exp <= currentUnixTimestamp()) {
        throw new Error("invalid token claims");
      }

      return claims;
    } catch {
      throw new AppError("AUTHENTICATION_ERROR", errorMessage, 401);
    }
  }
}

function signJwt(claims: AuthJwtClaims, secret: string): string {
  const header = encodeBase64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = encodeBase64Url(JSON.stringify(claims));
  const signature = createSignature(`${header}.${payload}`, secret);

  return `${header}.${payload}.${signature}`;
}

function verifyJwt(token: string, secret: string): AuthJwtClaims {
  const parts = token.split(".");

  if (parts.length !== 3) {
    throw new Error("invalid jwt format");
  }

  const [header, payload, signature] = parts;
  const expectedSignature = createSignature(`${header}.${payload}`, secret);

  if (!safeEqual(signature, expectedSignature)) {
    throw new Error("invalid jwt signature");
  }

  const decodedHeader = JSON.parse(decodeBase64Url(header)) as { alg?: string; typ?: string };

  if (decodedHeader.alg !== "HS256" || decodedHeader.typ !== "JWT") {
    throw new Error("unsupported jwt header");
  }

  const claims = JSON.parse(decodeBase64Url(payload)) as Partial<AuthJwtClaims>;

  if (
    typeof claims.sub !== "string" ||
    (claims.typ !== "access" && claims.typ !== "refresh") ||
    typeof claims.githubId !== "string" ||
    typeof claims.githubLogin !== "string" ||
    typeof claims.iat !== "number" ||
    typeof claims.exp !== "number"
  ) {
    throw new Error("invalid jwt claims");
  }

  return claims as AuthJwtClaims;
}

function createSignature(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function currentUnixTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}
