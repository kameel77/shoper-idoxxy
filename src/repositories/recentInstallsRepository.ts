export interface RecentInstall {
  shopId: string;
  shopUrl: string;
  timestamp: string;
}

// In-memory array to hold the latest installations (limit to 50)
let recentInstalls: RecentInstall[] = [];

export const recentInstallsRepository = {
  addInstall: (install: RecentInstall) => {
    // Avoid exact duplicates if install with same shopId is already at the top
    const existingIndex = recentInstalls.findIndex((i) => i.shopId === install.shopId);
    if (existingIndex > -1) {
      recentInstalls.splice(existingIndex, 1);
    }

    recentInstalls.unshift(install);

    if (recentInstalls.length > 50) {
      recentInstalls.pop();
    }
  },

  getRecentInstalls: (): RecentInstall[] => {
    return recentInstalls;
  },

  removeInstall: (shopId: string) => {
    recentInstalls = recentInstalls.filter((i) => i.shopId !== shopId);
  },
};
