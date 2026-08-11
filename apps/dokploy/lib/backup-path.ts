export const getBackupSearchPath = (appName: string, prefix: string) =>
	[appName, prefix]
		.map((part) => part.replace(/^\/+|\/+$/g, ""))
		.filter(Boolean)
		.join("/");
