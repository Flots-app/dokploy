type WhitelabelingConfig = {
	appName?: string | null;
};

/**
 * Whitelabeling went away with the license system: there is never a custom
 * branding. The hook stays so the service pages keep upstream's code (and its
 * merge surface); drop it when those pages are next touched.
 */
export function useWhitelabeling() {
	return { config: null as WhitelabelingConfig | null };
}
