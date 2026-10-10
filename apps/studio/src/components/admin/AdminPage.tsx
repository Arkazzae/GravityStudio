import { Studio } from '@/components/studio/Studio';

/** Existing administration bookmarks open the shared Settings surface. */
export function AdminPage() { return <Studio settings initialSettingsSection="users" />; }
