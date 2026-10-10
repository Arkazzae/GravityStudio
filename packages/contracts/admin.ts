export type UserRole = "admin" | "user";
export type UserStatus = "active" | "suspended" | "deleting" | "deleted";
export interface AdminUser {
  id: string;
  username: string;
  email: string | null;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  revision: number;
}
export interface Invitation {
  id: string;
  email: string | null;
  role: UserRole;
  createdAt: string;
  expiresAt: string;
  createdBy: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  acceptedBy: string | null;
  initialTimeMs: number;
  delivery: "not_sent" | "sent" | "failed";
}
export interface CreateInvitationInput {
  email?: string;
  role: UserRole;
  expiresInHours: number;
  initialTimeMs: number;
  sendEmail: boolean;
}
export interface CreatedInvitation { invitation: Invitation; url: string; deliveryError?: string }
export interface PublicInvitation { email: string | null; role: UserRole; expiresAt: string; initialTimeMs: number }
