export interface SyncStatus {
	ok: boolean;
	running?: boolean;
	revision?: number;
	error?: string;
	detail?: string;
	summary?: {
		moreHistory?: boolean;
		historyPaused?: boolean;
		pupils?: number;
		newEntries?: number;
		pagesFetched?: number;
	};
}
