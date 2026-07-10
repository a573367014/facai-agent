import type { AuthTokenPair, AuthTokenService } from "./auth-token-service.js";
import type { GithubOAuthClient } from "./github-oauth-client.js";
import type { UserRecord, UserStore } from "./user-store.js";

export interface AuthServiceOptions {
  githubClient: GithubOAuthClient;
  tokenService: AuthTokenService;
  userStore: UserStore;
}

export interface GithubLoginResult extends AuthTokenPair {
  user: UserRecord;
}

export class AuthService {
  constructor(private readonly options: AuthServiceOptions) {}

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
