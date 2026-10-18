import { useEffect, useState } from "react";

/** The current time, refreshed every second, so running durations tick. */
export const useNow = () => {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	return now;
};
