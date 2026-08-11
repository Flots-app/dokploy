export interface RcloneFile {
	Path: string;
	Name: string;
	Size: number;
	IsDir: boolean;
	Tier?: string;
	Hashes?: {
		MD5?: string;
		SHA1?: string;
	};
}

const getTopLevelPath = (path: string) => path.split("/", 1)[0] ?? "";

const getObjectSize = (file: RcloneFile) => {
	if (file.IsDir || !Number.isSafeInteger(file.Size) || file.Size < 0) {
		return 0;
	}

	return file.Size;
};

export const getBackupDirectoryEntries = (files: RcloneFile[]) => {
	const directorySizes = new Map<string, number>();

	for (const file of files) {
		if (file.IsDir) {
			continue;
		}

		const topLevelPath = getTopLevelPath(file.Path);
		if (topLevelPath === file.Path) {
			continue;
		}

		directorySizes.set(
			topLevelPath,
			(directorySizes.get(topLevelPath) ?? 0) + getObjectSize(file),
		);
	}

	const entries: RcloneFile[] = [];
	for (const file of files) {
		if (getTopLevelPath(file.Path) !== file.Path) {
			continue;
		}

		entries.push(
			file.IsDir ? { ...file, Size: directorySizes.get(file.Path) ?? 0 } : file,
		);
	}

	return entries;
};
