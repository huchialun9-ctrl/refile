export type DeviceStatus = "Online" | "Offline" | "Busy";
export type Transport = "lan" | "bluetooth";

export interface DeviceInfo {
  id: string;
  name: string;
  host: string;
  port: number;
  status: DeviceStatus;
  /** "lan" | "bluetooth" — undefined means LAN */
  transport?: Transport;
}

export type TransferDirection = "Send" | "Receive";

export type TransferStatus =
  | "Pending"
  | "Transferring"
  | "Verifying"
  | "Completed"
  | "Cancelled"
  | { Failed: string };

export interface TransferSession {
  id: string;
  peer_id: string;
  peer_name: string;
  file_name: string;
  file_size: number;
  file_count: number;
  direction: TransferDirection;
  status: TransferStatus;
  progress: number;
  speed: number;
  hash: string;
  created_at: string;
}
