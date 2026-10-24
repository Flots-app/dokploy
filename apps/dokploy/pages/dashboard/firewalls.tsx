import { validateRequest } from "@dokploy/server/lib/auth";
import { createServerSideHelpers } from "@trpc/react-query/server";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import superjson from "superjson";
import { ShowFirewalls } from "@/components/dashboard/firewalls/show-firewalls";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { appRouter } from "@/server/api/root";

const Page = () => <ShowFirewalls />;

export default Page;

Page.getLayout = (page: ReactElement) => {
	return <DashboardLayout metaName="Firewalls">{page}</DashboardLayout>;
};

export async function getServerSideProps(ctx: GetServerSidePropsContext) {
	const { user, session } = await validateRequest(ctx.req);
	if (!user) {
		return { redirect: { permanent: false, destination: "/" } };
	}
	const helpers = createServerSideHelpers({
		router: appRouter,
		ctx: {
			req: ctx.req as any,
			res: ctx.res as any,
			db: null as any,
			session: session as any,
			user: user as any,
		},
		transformer: superjson,
	});
	try {
		const permissions = await helpers.user.getPermissions.fetch();
		const isCloud = await helpers.settings.isCloud.fetch();
		if (isCloud || !permissions?.firewall.read) {
			return { redirect: { permanent: false, destination: "/dashboard/home" } };
		}
		await helpers.firewall.list.prefetch();
		return { props: { trpcState: helpers.dehydrate() } };
	} catch {
		return { props: {} };
	}
}
