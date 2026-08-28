export const isDeploymentConfirmationValid = (
	confirmation: string,
	environmentName: string,
) => confirmation === environmentName;
