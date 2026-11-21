import { validateRequest } from "@dokploy/server";
import { createServerSideHelpers } from "@trpc/react-query/server";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import superjson from "superjson";
import { ShowAuditLogs } from "@/components/dashboard/settings/audit-logs/show-audit-logs";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { appRouter } from "@/server/api/root";

const Page = () => <ShowAuditLogs />;

export default Page;

Page.getLayout = (page: ReactElement) => {
	return <DashboardLayout metaName="Audit Logs">{page}</DashboardLayout>;
};

export async function getServerSideProps(
	ctx: GetServerSidePropsContext<{ serviceId: string }>,
) {
	const { req, res } = ctx;
	const { user, session } = await validateRequest(req);

	if (!user) {
		return {
			redirect: {
				permanent: false,
				destination: "/",
			},
		};
	}

	const helpers = createServerSideHelpers({
		router: appRouter,
		ctx: {
			req: req as any,
			res: res as any,
			db: null as any,
			session: session as any,
			user: user as any,
		},
		transformer: superjson,
	});

	try {
		await helpers.user.get.prefetch();
		await helpers.settings.isCloud.prefetch();

		const userPermissions = await helpers.user.getPermissions.fetch();

		if (!userPermissions?.auditLog.read) {
			return {
				redirect: {
					permanent: false,
					destination: "/",
				},
			};
		}

		return {
			props: {
				trpcState: helpers.dehydrate(),
			},
		};
	} catch {
		return {
			props: {},
		};
	}
}
