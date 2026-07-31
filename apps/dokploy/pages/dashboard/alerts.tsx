import { IS_CLOUD } from "@dokploy/server/constants";
import { validateRequest } from "@dokploy/server/lib/auth";
import { hasPermission } from "@dokploy/server/services/permission";
import { ShieldAlert } from "lucide-react";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { ShowActiveAlerts } from "@/components/dashboard/alerts/show-active-alerts";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import {
	Card,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";

function AlertsPage() {
	return (
		<div className="w-full">
			<Card className="min-h-[45vh] rounded-xl bg-sidebar p-2.5">
				<div className="h-full rounded-xl bg-background shadow-md">
					<CardHeader>
						<CardTitle className="flex items-center gap-2 text-xl font-bold">
							<ShieldAlert className="size-5 text-destructive" />
							Alerts
						</CardTitle>
						<CardDescription>
							Every database alert that fired and has not received a matching
							resolution.
						</CardDescription>
					</CardHeader>
					<div className="px-6 pb-6">
						<ShowActiveAlerts />
					</div>
				</div>
			</Card>
		</div>
	);
}

export default AlertsPage;

AlertsPage.getLayout = (page: ReactElement) => {
	return <DashboardLayout>{page}</DashboardLayout>;
};

export async function getServerSideProps(ctx: GetServerSidePropsContext) {
	if (IS_CLOUD) {
		return {
			redirect: {
				permanent: false,
				destination: "/dashboard/home",
			},
		};
	}

	const { user, session } = await validateRequest(ctx.req);
	if (!user || !session?.activeOrganizationId) {
		return {
			redirect: {
				permanent: false,
				destination: "/",
			},
		};
	}

	const canView = await hasPermission(
		{
			user: { id: user.id },
			session: { activeOrganizationId: session.activeOrganizationId },
		},
		{ monitoring: ["read"] },
	);
	if (!canView) {
		return {
			redirect: {
				permanent: false,
				destination: "/dashboard/home",
			},
		};
	}

	return { props: {} };
}
