export interface TargetTab {
  id: number;
  title: string;
  url: string;
  favIconUrl?: string;
  lastAccessed?: number;
}

export interface TargetTabStatus {
  target: TargetTab | null;
  active: TargetTab | null;
  missing: boolean;
  busy: boolean;
}

export interface TargetTabBinding {
  messageId: number;
  target: TargetTab;
}
