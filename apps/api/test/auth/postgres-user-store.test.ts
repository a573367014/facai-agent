import { describe, expect, it } from "vitest";
import { PostgresUserStore } from "../../src/auth/postgres-user-store.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/agent_test";

describe("PostgresUserStore", () => {
  it("创建 users 表，并按 GitHub id 幂等更新用户资料", async () => {
    const store = await PostgresUserStore.create({ connectionString: TEST_DATABASE_URL });
    await store.reset();

    const firstUser = await store.upsertGithubUser({
      githubId: "9911",
      githubLogin: "octocat",
      name: "The Octocat",
      email: "octocat@example.com",
      avatarUrl: "https://avatars.githubusercontent.com/u/9911",
      githubUrl: "https://github.com/octocat"
    });
    const secondUser = await store.upsertGithubUser({
      githubId: "9911",
      githubLogin: "octocat-renamed",
      name: "Mona",
      email: "mona@example.com",
      avatarUrl: "https://avatars.githubusercontent.com/u/9911?v=2",
      githubUrl: "https://github.com/octocat-renamed"
    });

    expect(secondUser.id).toBe(firstUser.id);
    expect(secondUser).toMatchObject({
      githubId: "9911",
      githubLogin: "octocat-renamed",
      name: "Mona",
      email: "mona@example.com",
      avatarUrl: "https://avatars.githubusercontent.com/u/9911?v=2",
      githubUrl: "https://github.com/octocat-renamed"
    });
    expect(await store.getUserById(firstUser.id)).toMatchObject({
      id: firstUser.id,
      githubLogin: "octocat-renamed"
    });

    await store.close();
  });
});
