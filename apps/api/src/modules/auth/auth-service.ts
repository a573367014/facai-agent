/**
 * 认证服务 —— 登录流程的"编排者"（Orchestrator）。
 *
 * 【职责边界】
 * 本文件是认证模块的业务核心，但它本身几乎不含具体实现细节。
 * 它通过组合三个依赖（githubClient + userStore + tokenService），
 * 把"换 GitHub 资料 → 存用户 → 发 token"三步串成一条完整链路。
 *
 * 这就是典型的"编排层"模式：不亲自干活，只负责按正确顺序调用各组件。
 * 好处是——任何一个组件的实现都可以独立替换（如换存储、换 token 方案），
 * 而编排逻辑不受影响。
 *
 * 通俗比喻：AuthService 是流水线上的调度员，它自己不造零件，
 * 只负责把零件按顺序传下去：GitHub 客户端取料 → 仓库建档 → 钥匙房发卡。
 */
import type { AuthTokenPair, AuthTokenService } from "./auth-token-service.js";
import type { GithubOAuthClient } from "./github-oauth-client.js";
import type { UserRecord, UserStore } from "./user-store.js";

/** 三个核心依赖通过依赖注入传入，解耦具体实现 */
export interface AuthServiceOptions {
  githubClient: GithubOAuthClient;
  tokenService: AuthTokenService;
  userStore: UserStore;
}

/** 登录结果：既包含用户资料，也包含签发的 token 对 */
export interface GithubLoginResult extends AuthTokenPair {
  user: UserRecord;
}

export class AuthService {
  constructor(private readonly options: AuthServiceOptions) {}

  /**
   * GitHub 登录的完整编排流程。
   *
   * 三步走：
   * 1. 用 code 向 GitHub 换取用户资料（外部依赖调用）
   * 2. upsert 用户到本地存储（首次登录则创建，重复登录则更新资料 + 刷新 lastLoginAt）
   * 3. 基于用户 id 签发 token 对（供客户端后续鉴权使用）
   *
   * 【为什么 upsert 而非 insert】
   * GitHub 用户可能多次登录，每次都必须更新头像/昵称等可能变更的信息，
   * 同时刷新 lastLoginAt。用 upsert（有则更新、无则创建）天然保证幂等，
   * 无论用户登录多少次，系统中始终只有一条记录。
   */
  async loginWithGithubCode(input: { code: string; redirectUri?: string }): Promise<GithubLoginResult> {
    const profile = await this.options.githubClient.getUserProfile(input);
    const user = await this.options.userStore.upsertGithubUser(profile);
    const tokenPair = this.options.tokenService.issueTokenPair({
      userId: user.id,
      githubId: user.githubId,
      githubLogin: user.githubLogin
    });

    return {
      user,
      ...tokenPair
    };
  }
}
