/**
 * GitHub OAuth 客户端 —— 与 GitHub 平台对接的"门面"。
 *
 * 【职责边界】
 * 本文件只做一件事：拿到前端传来的 GitHub 授权码（code），
 * 通过 GitHub 的 OAuth 接口换出用户的身份资料（githubId、login、email 等）。
 * 它不关心后续如何建用户、如何签发 token——那是 AuthService 的事。
 *
 * 【OAuth 2.0 Authorization Code 流程回顾】
 * 完整链路是：前端跳转 GitHub 授权页 → 用户同意 → GitHub 回调带上 code
 * → 前端把 code 发给本服务 → 本服务用 code + clientId + clientSecret
 *   向 GitHub 换 access_token → 再用 access_token 调 GitHub API 拿用户信息。
 *
 * 之所以 code 必须在服务端换取 token（而不是前端直接换），
 * 是因为换取时需要 clientSecret，这个密钥绝不能暴露给浏览器。
 *
 * 通俗比喻：code 是一张"兑换券"，clientSecret 是"兑换密码"，
 * 兑换密码只能藏在后端保险柜里，前端拿着兑换券来柜台，后端替它去换。
 */
import { AppError } from "../../shared/errors/app-error.js";

/** 从 GitHub 获取到的、归一化后的用户资料，供上层存入 UserStore */
export interface GithubUserProfile {
  githubId: string;
  githubLogin: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
  githubUrl?: string;
}

/** OAuth 客户端抽象接口，方便测试时用 mock 替换真实 HTTP 调用 */
export interface GithubOAuthClient {
  getUserProfile(input: { code: string; redirectUri?: string }): Promise<GithubUserProfile>;
}

export interface HttpGithubOAuthClientOptions {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}

/** GitHub access_token 接口的响应结构。字段可选，因为失败时会返回 error 而非 token */
interface GithubAccessTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

/** GitHub /user 接口返回的原始字段（snake_case，与 GitHub API 保持一致） */
interface GithubUserResponse {
  id?: number;
  login?: string;
  name?: string | null;
  email?: string | null;
  avatar_url?: string;
  html_url?: string;
}

/** GitHub /user/emails 接口返回的单个邮箱条目 */
interface GithubEmailResponse {
  email?: string;
  primary?: boolean;
  verified?: boolean;
}

export class HttpGithubOAuthClient implements GithubOAuthClient {
  constructor(private readonly options: HttpGithubOAuthClientOptions) {}

  /**
   * 用授权码换取完整的用户资料，分三步：
   * 1. code → access_token（服务端持有，用完即弃，不持久化）
   * 2. access_token → 用户基本信息（/user 接口）
   * 3. 补充邮箱：/user 接口可能不返回 email（用户设了隐私），则回退调 /user/emails
   *
   * 【为什么 email 要单独获取】
   * GitHub 允许用户隐藏邮箱，此时 /user 接口返回的 email 为 null。
   * 但 /user/emails 接口能列出所有邮箱（含 primary 标记），
   * 我们取第一个"已验证且设为主要"的邮箱作为可信地址。
   */
  async getUserProfile(input: { code: string; redirectUri?: string }): Promise<GithubUserProfile> {
    const accessToken = await this.exchangeCodeForAccessToken(input);
    const user = await this.fetchGithubUser(accessToken);
    const email = user.email ?? (await this.fetchPrimaryEmail(accessToken));

    // id 和 login 是后续创建用户的必要字段，缺失说明 GitHub 返回了异常数据，必须拒绝
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

  /**
   * 第一步：用授权码向 GitHub 换取 access_token。
   * 这是整个 OAuth 流程的核心交换动作，需要 clientSecret 鉴权。
   */
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
        // redirect_uri 必须与最初发起授权时一致，否则 GitHub 会拒绝
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

  /**
   * 第二步：用 access_token 调用 GitHub /user 接口获取用户基本信息。
   * user-agent 头是 GitHub API 的强制要求，不带会被拒绝。
   */
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

  /**
   * 第三步（回退）：当 /user 没返回 email 时，从 /user/emails 接口取。
   *
   * 【为什么失败时返回 undefined 而非抛错】
   * 邮箱是可选信息，用户可能没有任何公开邮箱。这里选择容错：
   * 获取失败就返回 undefined，让上层决定是否接受无邮箱用户。
   */
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
    // 只取已验证且标记为主要的邮箱，避免拿到无效或低优先级的地址
    return emails.find((email) => email.primary && email.verified)?.email;
  }
}
