export const AVATAR_THEME_IDS = ["studio", "lime", "mint", "blue", "violet", "rose"] as const;
export type AvatarThemeId = typeof AVATAR_THEME_IDS[number];

export interface AccountProfile {
  revision: number;
  displayName: string;
  workspaceName: string;
  avatarTheme: AvatarThemeId;
}
