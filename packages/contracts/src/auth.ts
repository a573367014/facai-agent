export interface AuthUserDto {
  id: string;
  githubId: string;
  githubLogin: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
  githubUrl?: string;
}

export interface AuthTokenPairDto {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshTokenExpiresIn: number;
}

export interface AuthSessionDto extends AuthTokenPairDto {
  user: AuthUserDto;
}

export type GithubLoginResponse = AuthSessionDto;

export interface CurrentUserResponse {
  user: AuthUserDto;
}
