import semver from "semver";

const OFFICIAL_IMAGE_REPOSITORY = "dokploy/dokploy";
const OFFICIAL_RELEASE_REPOSITORY = "Dokploy/dokploy";
const GITHUB_REPOSITORY_PATTERN =
	/^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/;

export interface IUpdateData {
	latestVersion: string | null;
	updateAvailable: boolean;
	releaseUrl: string | null;
}

export const DEFAULT_UPDATE_DATA: IUpdateData = {
	latestVersion: null,
	updateAvailable: false,
	releaseUrl: null,
};

export const getDokployImageRepository = () =>
	process.env.DOKPLOY_IMAGE_REPOSITORY?.trim() || OFFICIAL_IMAGE_REPOSITORY;

export const getDokployReleaseRepository = () => {
	const configuredRepository = process.env.DOKPLOY_RELEASE_REPOSITORY?.trim();
	if (
		configuredRepository &&
		GITHUB_REPOSITORY_PATTERN.test(configuredRepository)
	) {
		return configuredRepository;
	}
	return OFFICIAL_RELEASE_REPOSITORY;
};

export const getDokployReleaseUrl = () =>
	`https://github.com/${getDokployReleaseRepository()}/releases`;

export const getDokployUpdateImage = (version: string) =>
	`${getDokployImageRepository()}:${version}`;

export const getDokployServiceUpdateArgs = (version: string) => [
	"service",
	"update",
	"--force",
	"--with-registry-auth",
	"--image",
	getDokployUpdateImage(version),
	"dokploy",
];

interface GithubRelease {
	tag_name?: unknown;
	html_url?: unknown;
}

export const getStableUpdateData = async (
	currentVersion: string,
	fetcher: typeof fetch = fetch,
): Promise<IUpdateData> => {
	const repository = getDokployReleaseRepository();
	const releaseUrl = getDokployReleaseUrl();

	try {
		const response = await fetcher(
			`https://api.github.com/repos/${repository}/releases/latest`,
			{
				method: "GET",
				headers: {
					Accept: "application/vnd.github+json",
					"User-Agent": "dokploy-update-check",
					"X-GitHub-Api-Version": "2022-11-28",
				},
			},
		);

		if (!response.ok) {
			throw new Error(`GitHub releases API returned ${response.status}`);
		}

		const release = (await response.json()) as GithubRelease;
		if (typeof release.tag_name !== "string") {
			return {
				...DEFAULT_UPDATE_DATA,
				releaseUrl,
			};
		}

		const cleanedCurrent = semver.clean(currentVersion);
		const cleanedLatest = semver.clean(release.tag_name);
		if (!cleanedCurrent || !cleanedLatest) {
			return {
				...DEFAULT_UPDATE_DATA,
				releaseUrl,
			};
		}

		return {
			latestVersion: release.tag_name,
			updateAvailable: semver.gt(cleanedLatest, cleanedCurrent),
			releaseUrl:
				typeof release.html_url === "string" ? release.html_url : releaseUrl,
		};
	} catch (error) {
		console.error(`Error fetching Dokploy releases from ${repository}:`, error);
		return {
			...DEFAULT_UPDATE_DATA,
			releaseUrl,
		};
	}
};
