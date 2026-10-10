export type StorageMeasurementStatus = "complete" | "partial" | "unavailable";
export type StorageCategoryId = "image-models" | "language-models" | "tools" | "database" | "images" | "runtime" | "other";

export interface StorageCategoryUsage {
  id: StorageCategoryId;
  label: string;
  /** Logical file sizes. Partial measurements are lower bounds. */
  bytes: number | null;
  /** Allocated filesystem blocks; hard-linked files count once. */
  allocatedBytes: number | null;
  files: number;
  status: StorageMeasurementStatus;
}

export interface StorageUsage {
  sampledAt: string;
  cacheExpiresAt: string;
  /** The filesystem containing Studio's data directory, including non-Studio files. */
  volume: {
    status: "available" | "unavailable";
    totalBytes: number | null;
    usedBytes: number | null;
    /** Includes space reserved for the filesystem administrator. */
    freeBytes: number | null;
    /** Space available to the Studio process. */
    availableBytes: number | null;
    message?: string;
  };
  local: {
    status: StorageMeasurementStatus;
    bytes: number | null;
    allocatedBytes: number | null;
    files: number;
    categories: StorageCategoryUsage[];
    warnings: string[];
  };
  /** Largest measured model files; names are relative to their model directory. */
  largestModelFiles: Array<{ name: string; categoryId: "image-models" | "language-models" | "tools"; bytes: number }>;
  /** More measured files exist than the list limit, or the model scan was incomplete. */
  modelFilesTruncated: boolean;
  /** Recorded managed S3/RustFS objects; never bucket capacity or server disk usage. */
  objectStorage: {
    configured: boolean;
    status: StorageMeasurementStatus;
    bytes: number | null;
    files: number;
    inputsBytes: number | null;
    outputsBytes: number | null;
    unknownSizeFiles: number;
    message: string;
  };
}
