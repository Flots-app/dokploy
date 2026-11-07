import {
	Body,
	Button,
	Container,
	Head,
	Heading,
	Html,
	Img,
	Preview,
	Section,
	Tailwind,
	Text,
} from "@react-email/components";
import { emailTailwindConfig } from "../tailwind-config";

export type TemplateProps = {
	heading: string;
	message: string;
	facts: { name: string; value: string }[];
	link: string;
};

export const OsUpdateNoticeEmail = ({
	heading = "OS updates failed on web-1",
	message = "apt-get upgrade failed: dpkg returned an error code (1). Nothing was rebooted.",
	facts = [
		{ name: "Server", value: "web-1" },
		{ name: "Configuration", value: "Weekly security" },
		{ name: "Date", value: "2026-11-07 02:41 UTC" },
	],
	link = "https://dokploy.example.com/dashboard/os-updates",
}: TemplateProps) => (
	<Html>
		<Preview>{heading}</Preview>
		<Tailwind config={emailTailwindConfig}>
			<Head />
			<Body className="bg-white my-auto mx-auto font-sans px-2">
				<Container className="border border-solid border-[#eaeaea] rounded-lg my-[40px] mx-auto p-[20px] max-w-[465px]">
					<Section className="mt-[32px]">
						<Img
							src={
								"https://raw.githubusercontent.com/Dokploy/dokploy/refs/heads/canary/apps/dokploy/logo.png"
							}
							width="100"
							height="50"
							alt="Dokploy"
							className="my-0 mx-auto"
						/>
					</Section>
					<Heading className="text-black text-[24px] font-normal text-center p-0 my-[30px] mx-0">
						{heading}
					</Heading>
					<Text className="text-black text-[14px] leading-[24px]">
						{message}
					</Text>
					<Section className="flex text-black text-[14px] leading-[24px] bg-[#F4F4F5] rounded-lg p-2">
						<Text className="!leading-3 font-bold">Details: </Text>
						{facts.map((fact) => (
							<Text key={fact.name} className="!leading-3">
								{fact.name}: <strong>{fact.value}</strong>
							</Text>
						))}
					</Section>
					<Section className="text-center mt-[32px] mb-[32px]">
						<Button
							href={link}
							className="bg-[#000000] rounded text-white text-[12px] font-semibold no-underline text-center px-5 py-3"
						>
							Open OS Updates
						</Button>
					</Section>
				</Container>
			</Body>
		</Tailwind>
	</Html>
);

export default OsUpdateNoticeEmail;
