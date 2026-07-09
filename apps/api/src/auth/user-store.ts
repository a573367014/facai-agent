import { randomUUID } from "node:crypto";

export interface UserRecord {
  id: string;
  githubId: string;
  githubLogin: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
  githubUrl?: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string;
}

export interface GithubUserInput {
  githubId: string;
  githubLogin: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
  githubUrl?: string;
}

export interface UserStore {
  upsertGithubUser(input: GithubUserInput): Promise<UserRecord>;
  getUserById(userId: string): Promise<UserRecord | undefined>;
}

export class InMemoryUserStore implements UserStore {
  private readonly usersById = new Map<string, UserRecord>();
  private readonly idsByGithubId = new Map<string, string>();

  async upsertGithubUser(input: GithubUserInput): Promise<UserRecord> {
    const timestamp = new Date().toISOString();
    const existingId = this.idsByGithubId.get(input.githubId);
    const existingUser = existingId ? this.usersById.get(existingId) : undefined;
    const user: UserRecord = {
      id: existingUser?.id ?? `user_${randomUUID()}`,
      githubId: input.githubId,
      githubLogin: input.githubLogin,
      name: input.name,
      email: input.email,
      avatarUrl: input.avatarUrl,
      githubUrl: input.githubUrl,
      createdAt: existingUser?.createdAt ?? timestamp,
      updatedAt: timestamp,
      lastLoginAt: timestamp
    };

    this.usersById.set(user.id, user);
    this.idsByGithubId.set(user.githubId, user.id);
    return user;
  }

  async getUserById(userId: string): Promise<UserRecord | undefined> {
    return this.usersById.get(userId);
  }
}
