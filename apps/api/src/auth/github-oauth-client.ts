import { AppError } from "../errors/app-error.js";

export interface GithubUserProfile {
  githubId: string;
  githubLogin: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
  githubUrl?: string;
}

export interface GithubOAuthClient {
  getUserProfile(input: { code: string; redirectUri?: string }): Promise<GithubUserProfile>;
}

export interface HttpGithubOAuthClientOptions {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}

interface GithubAccessTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GithubUserResponse {
  id?: number;
  login?: string;
  name?: string | null;
  email?: string | null;
  avatar_url?: string;
  html_url?: string;
}

interface GithubEmailResponse {
  email?: string;
  primary?: boolean;
  verified?: boolean;
}

export class HttpGithubOAuthClient implements GithubOAuthClient {
  constructor(private readonly options: HttpGithubOAuthClientOptions) {}

  async getUserProfile(input: { code: string; redirectUri?: string }): Promise<GithubUserProfile> {
    const accessToken = await this.exchangeCodeForAccessToken(input);
    const user = await this.fetchGithubUser(accessToken);
    const email = user.email ?? (await this.fetchPrimaryEmail(accessToken));

    if (typeof user.id !== "number" || typeof user.login !== "string") {
      throw new AppError("AUTHENTICATION_ERROR", "GitHub 用户资料缺少必要字段", 502);
    }

    return {
      githubId: String(user.id),
      githubLogin: user.login,
      name: user.name ?? undefined,
      email,
      avatarUrl: user.avatar_url,
      githubUrl: user.html_url
    };
  }

  private async exchangeCodeForAccessToken(input: { code: string; redirectUri?: string }): Promise<string> {
    if (!this.options.clientId || !this.options.clientSecret) {
      throw new AppError("AUTHENTICATION_ERROR", "GitHub OAuth 未配置 clientId/clientSecret", 500);
    }

    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri ?? this.options.redirectUri
      })
    });
    const payload = (await response.json()) as GithubAccessTokenResponse;

    if (!response.ok || payload.error || !payload.access_token) {
      throw new AppError(
        "AUTHENTICATION_ERROR",
        payload.error_description ?? payload.error ?? "GitHub code 换取 access token 失败",
        401
      );
    }

    return payload.access_token;
  }

  private async fetchGithubUser(accessToken: string): Promise<GithubUserResponse> {
    const response = await fetch("https://api.github.com/user", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "facai-agent"
      }
    });

    if (!response.ok) {
      throw new AppError("AUTHENTICATION_ERROR", "读取 GitHub 用户资料失败", 401);
    }

    return (await response.json()) as GithubUserResponse;
  }

  private async fetchPrimaryEmail(accessToken: string): Promise<string | undefined> {
    const response = await fetch("https://api.github.com/user/emails", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "facai-agent"
      }
    });

    if (!response.ok) {
      return undefined;
    }

    const emails = (await response.json()) as GithubEmailResponse[];
    return emails.find((email) => email.primary && email.verified)?.email;
  }
}
