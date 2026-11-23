(() => {
	const config = window.TMMW_SUPABASE_CONFIG;
	const loginPanel = document.getElementById("login-panel");
	const dashboard = document.getElementById("dashboard");
	const loginForm = document.getElementById("login-form");
	const loginButton = document.getElementById("login-button");
	const loginStatus = document.getElementById("login-status");
	const dashboardStatus = document.getElementById("dashboard-status");
	const subscriptionDetails = document.getElementById("subscription-details");
	const planOptions = document.getElementById("plan-options");
	const checkoutStatus = document.getElementById("checkout-status");
	const pageParams = new URLSearchParams(window.location.search);
	let supabaseClient;
	let latestLoadId = 0;

	// Matches has_active_subscription() on the server: paying, trialing, or past due while Stripe retries.
	const ACCESS_STATUSES = ["trialing", "active", "past_due"];
	const STATUS_TEXT = {
		trialing: "Free trial",
		active: "Active",
		past_due: "Payment issue — Stripe is retrying your card; access continues for now.",
		canceled: "Canceled",
		unpaid: "Unpaid — access paused",
		incomplete: "Waiting for first payment",
		incomplete_expired: "Checkout not completed",
		paused: "Paused"
	};
	const MAX_SEATS = 50;
	const seatErrors = {
		invalid_email: "Please enter a valid email address.",
		own_email: "That’s your own email — your seat is already included.",
		no_free_seats: "All seats are in use. Add seats with Manage subscription, or remove someone first.",
		already_added: "That email already has a seat.",
		no_subscription: "Your subscription isn’t active."
	};
	const checkoutErrors = {
		already_subscribed: "You already have an active subscription.",
		plan_unavailable: "This plan isn’t available yet.",
		unauthorized: "Please sign in again before subscribing.",
		invalid_seats: "Choose between 1 and 50 seats.",
		origin_not_allowed: "Checkout can only be started from the TMMW website."
	};

	function setStatus(element, message, kind = "info") {
		element.textContent = message;
		element.dataset.kind = kind;
	}

	function makeRecord(title, lines) {
		const article = document.createElement("article");
		article.className = "record";
		const heading = document.createElement("h3");
		heading.textContent = title;
		article.append(heading);
		for (const [text, className = ""] of lines) {
			const paragraph = document.createElement("p");
			paragraph.textContent = text;
			if (className) paragraph.className = className;
			article.append(paragraph);
		}
		return article;
	}

	function formatMinor(amount, currency) {
		const code = (currency || "EUR").toUpperCase();
		const fractionDigits = new Intl.NumberFormat("en", { style: "currency", currency: code })
			.resolvedOptions().maximumFractionDigits;
		return new Intl.NumberFormat(undefined, { style: "currency", currency: code })
			.format((amount ?? 0) / (10 ** fractionDigits));
	}

	function formatDate(value) {
		return value ? new Date(value).toLocaleDateString(undefined, { dateStyle: "long" }) : "";
	}

	function showSignedOut(message = "") {
		loginPanel.classList.remove("hidden");
		dashboard.classList.add("hidden");
		if (message) setStatus(loginStatus, message);
	}

	function renderSubscription(subscription, seats) {
		const interval = subscription.billing_interval === "year" ? "Yearly" : "Monthly";
		const quantity = subscription.quantity ?? 1;
		const lines = [[STATUS_TEXT[subscription.status] ?? `Status: ${subscription.status}`]];
		if (ACCESS_STATUSES.includes(subscription.status) && subscription.current_period_end) {
			const end = formatDate(subscription.current_period_end);
			lines.push([subscription.cancel_at_period_end
				? `Ends on ${end} — it won’t renew.`
				: subscription.status === "trialing"
					? `Trial ends on ${end}; your first payment is taken then.`
					: `Renews on ${end}.`, "record-meta"]);
		}
		const title = quantity > 1 ? `TMMW studio subscription · ${interval} · ${quantity} seats` : `TMMW subscription · ${interval}`;
		const record = makeRecord(title, lines);
		const manageButton = document.createElement("button");
		manageButton.type = "button";
		manageButton.textContent = subscription.status === "past_due" ? "Update payment method" : "Manage subscription";
		manageButton.addEventListener("click", () => void openPortal(manageButton));
		const actions = document.createElement("div");
		actions.className = "account-actions record-actions";
		actions.append(manageButton);
		record.append(actions, makeParagraph(quantity > 1
			? "Change plan or number of seats, update your card, download invoices, or cancel."
			: "Change plan, update your card, download invoices, or cancel. Need seats for your team? Add them here too.", "record-meta"));
		subscriptionDetails.append(record);
		if (quantity > 1) subscriptionDetails.append(renderSeats(quantity, seats));
	}

	function renderSeats(quantity, seats) {
		const shareable = quantity - 1;
		const used = Math.min(seats.length, shareable);
		const record = makeRecord(`Team seats · ${used + 1} of ${quantity} in use`, [
			["Your own seat is included. Each person signs in at this page with the email you add here.", "record-meta"]
		]);
		if (seats.length > shareable) {
			record.append(makeParagraph(`You have ${seats.length} people for ${shareable} shareable seats. The most recently added ${seats.length - shareable === 1 ? "person has" : "people have"} no access until you add seats or remove someone.`, "status-inline error"));
		}
		const list = document.createElement("ul");
		list.className = "seat-list";
		for (const seat of seats) {
			const item = document.createElement("li");
			const email = document.createElement("span");
			email.textContent = seat.email;
			const state = document.createElement("span");
			state.className = "record-meta";
			state.textContent = seat.has_access ? "Has access" : "No access — over seat limit";
			const remove = document.createElement("button");
			remove.type = "button";
			remove.className = "button-quiet";
			remove.textContent = "Remove";
			remove.setAttribute("aria-label", `Remove ${seat.email}`);
			remove.addEventListener("click", () => void removeSeat(seat, remove));
			item.append(email, state, remove);
			list.append(item);
		}
		if (seats.length) record.append(list);

		if (seats.length < shareable) {
			const form = document.createElement("form");
			form.className = "seat-form";
			const label = document.createElement("label");
			label.htmlFor = "seat-email";
			label.textContent = `Add a team member (${shareable - seats.length} free)`;
			const input = document.createElement("input");
			input.id = "seat-email";
			input.type = "email";
			input.required = true;
			input.autocomplete = "off";
			input.placeholder = "name@studio.com";
			const submit = document.createElement("button");
			submit.type = "submit";
			submit.textContent = "Add seat";
			const row = document.createElement("div");
			row.className = "account-actions";
			row.append(input, submit);
			form.append(label, row);
			form.addEventListener("submit", (event) => {
				event.preventDefault();
				void addSeat(input.value, submit);
			});
			record.append(form);
		}
		return record;
	}

	async function addSeat(email, button) {
		button.disabled = true;
		setStatus(checkoutStatus, "Adding seat…");
		const { error } = await supabaseClient.rpc("add_subscription_seat", { p_email: email });
		if (error) {
			console.error("Could not add seat", error);
			setStatus(checkoutStatus, seatErrors[error.message] ?? "We couldn’t add that seat. Please try again.", "error");
			button.disabled = false;
			return;
		}
		setStatus(checkoutStatus, `Seat added. Ask ${email.trim()} to sign in at tmmw.app/account with that email.`);
		await reloadDashboard();
	}

	async function removeSeat(seat, button) {
		if (!window.confirm(`Remove ${seat.email}? They lose access to TMMW plugins right away.`)) return;
		button.disabled = true;
		const { error } = await supabaseClient.rpc("remove_subscription_seat", { p_seat_id: seat.id });
		if (error) {
			console.error("Could not remove seat", error);
			setStatus(checkoutStatus, "We couldn’t remove that seat. Please try again.", "error");
			button.disabled = false;
			return;
		}
		setStatus(checkoutStatus, `${seat.email} was removed.`);
		await reloadDashboard();
	}

	async function reloadDashboard() {
		const { data } = await supabaseClient.auth.getSession();
		if (data.session?.user) await loadDashboard(data.session.user, { keepCheckoutStatus: true });
	}

	function renderSeatAccess(seat) {
		const lines = [[seat.has_access ? "Active — you have access to every TMMW plugin." : "No access right now."]];
		lines.push([`Seat provided by ${seat.owner_email}.`, "record-meta"]);
		if (seat.has_access && seat.cancel_at_period_end && seat.current_period_end) {
			lines.push([`The studio subscription ends on ${formatDate(seat.current_period_end)}.`, "record-meta"]);
		}
		if (!seat.has_access) lines.push(["Ask the account owner to free up or add a seat.", "record-meta"]);
		subscriptionDetails.append(makeRecord("Studio seat", lines));
	}

	function makeParagraph(text, className) {
		const paragraph = document.createElement("p");
		paragraph.textContent = text;
		paragraph.className = className;
		return paragraph;
	}

	async function openPortal(button) {
		button.disabled = true;
		setStatus(checkoutStatus, "Opening Stripe billing portal…");
		const { data, error } = await supabaseClient.functions.invoke("create-portal-session");
		if (!error && typeof data?.url === "string" && data.url.startsWith("https://billing.stripe.com/")) {
			window.location.assign(data.url);
			return;
		}
		console.error("Billing portal could not open", error);
		setStatus(checkoutStatus, "The billing portal is unavailable right now. Please try again shortly, or contact us.", "error");
		button.disabled = false;
	}

	function renderPlans(prices, offerTrial) {
		planOptions.replaceChildren();
		const seatLabel = document.createElement("label");
		seatLabel.className = "seat-count";
		seatLabel.textContent = "Seats";
		const seatInput = document.createElement("input");
		seatInput.type = "number";
		seatInput.min = "1";
		seatInput.max = String(MAX_SEATS);
		seatInput.value = "1";
		seatInput.inputMode = "numeric";
		seatLabel.append(seatInput);
		const seatHint = document.createElement("p");
		seatHint.className = "record-meta plan-hint";
		const buttons = [];
		const ordered = [...prices].sort((a, b) => (a.billing_interval === "year") - (b.billing_interval === "year"));
		for (const price of ordered) {
			const button = document.createElement("button");
			button.type = "button";
			button.addEventListener("click", () => void startCheckout(price.billing_interval, seatCount()));
			buttons.push([button, price]);
		}
		function seatCount() {
			const value = Number.parseInt(seatInput.value, 10);
			return Number.isInteger(value) ? Math.min(Math.max(value, 1), MAX_SEATS) : 1;
		}
		function updateLabels() {
			const seats = seatCount();
			for (const [button, price] of buttons) {
				const per = price.billing_interval === "year" ? "year" : "month";
				const amount = `${formatMinor(price.unit_amount * seats, price.currency)}/${per}`;
				const label = price.billing_interval === "year" ? "Yearly" : "Monthly";
				button.textContent = offerTrial ? `${label} · 14 days free, then ${amount}` : `${label} · ${amount}`;
			}
			seatHint.textContent = seats > 1
				? `${seats} seats: one for you, ${seats - 1} to share with your team by email. Prices before tax.`
				: "Buying for a studio? Choose more seats and share them with your team. Prices before tax.";
		}
		seatInput.addEventListener("input", updateLabels);
		updateLabels();
		if (ordered.length) planOptions.append(seatLabel, ...buttons.map(([button]) => button), seatHint);
		planOptions.classList.toggle("hidden", !ordered.length);
		if (!ordered.length) setStatus(checkoutStatus, "Subscriptions aren’t open yet.");
	}

	async function startCheckout(interval, seats) {
		for (const control of planOptions.querySelectorAll("button, input")) control.disabled = true;
		setStatus(checkoutStatus, "Opening secure checkout…");
		const { data, error } = await supabaseClient.functions.invoke("create-checkout", { body: { interval, seats } });
		if (!error && typeof data?.url === "string" && data.url.startsWith("https://checkout.stripe.com/")) {
			window.location.assign(data.url);
			return;
		}
		let code = "";
		try { code = (await error?.context?.json())?.error ?? ""; } catch { /* non-JSON error body */ }
		console.error("Checkout could not start", code || error);
		setStatus(checkoutStatus, checkoutErrors[code] ?? "Checkout is unavailable right now. Please try again shortly.", "error");
		for (const control of planOptions.querySelectorAll("button, input")) control.disabled = false;
	}

	async function loadDashboard(user, { keepCheckoutStatus = false } = {}) {
		loginPanel.classList.add("hidden");
		dashboard.classList.remove("hidden");
		document.getElementById("signed-in-email").textContent = user.email ?? "Signed in";
		setStatus(dashboardStatus, "Loading your account…");
		const loadId = ++latestLoadId;

		const [subscriptionResult, priceResult, seatsResult, seatAccessResult] = await Promise.all([
			supabaseClient.from("subscriptions")
				.select("status,billing_interval,quantity,current_period_end,cancel_at_period_end,created_at")
				.order("created_at", { ascending: false }),
			supabaseClient.from("product_prices")
				.select("billing_interval,unit_amount,currency")
				.not("billing_interval", "is", null),
			supabaseClient.rpc("list_my_seats"),
			supabaseClient.rpc("my_seat_access")
		]);
		// Sign-in fires several auth events; only the newest load may render.
		if (loadId !== latestLoadId) return;
		subscriptionDetails.replaceChildren();

		const loadError = subscriptionResult.error ?? priceResult.error ?? seatsResult.error ?? seatAccessResult.error;
		if (loadError) {
			console.error("Could not load account records", loadError);
			setStatus(dashboardStatus, "We couldn’t load your account. Please refresh and try again.", "error");
			return;
		}

		const subscriptions = subscriptionResult.data ?? [];
		const current = subscriptions.find((item) => ACCESS_STATUSES.includes(item.status));
		const seatAccess = (seatAccessResult.data ?? []).find((seat) => seat.has_access);
		if (current) {
			renderSubscription(current, seatsResult.data ?? []);
			planOptions.classList.add("hidden");
			if (!keepCheckoutStatus) setStatus(checkoutStatus, "");
		} else if (seatAccess) {
			renderSeatAccess(seatAccess);
			planOptions.classList.add("hidden");
			if (!keepCheckoutStatus) setStatus(checkoutStatus, "");
		} else {
			const lostSeat = (seatAccessResult.data ?? [])[0];
			if (lostSeat) renderSeatAccess(lostSeat);
			const last = subscriptions.find((item) => item.status !== "incomplete_expired");
			subscriptionDetails.append(last
				? makeRecord("No active subscription", [["Your previous subscription has ended. Subscribe again to keep using TMMW plugins."]])
				: makeRecord("No subscription yet", [["One subscription unlocks every TMMW plugin. New subscribers get a 14-day free trial."]]));
			// Mirrors create-checkout: only accounts that never subscribed get the trial.
			renderPlans(priceResult.data ?? [], !subscriptions.some((item) => item.status !== "incomplete_expired"));
		}

		const justSubscribed = pageParams.get("checkout") === "complete";
		setStatus(dashboardStatus, justSubscribed && !current && !seatAccess
			? "Thanks! Your payment is being confirmed — refresh in a moment if your subscription isn’t shown yet."
			: "Account details are up to date.");
	}

	if (!window.supabase?.createClient || !config?.url || config.url.includes("YOUR_PROJECT_REF") ||
		!config?.publishableKey || config.publishableKey.includes("YOUR_SUPABASE_PUBLISHABLE_KEY")) {
		loginButton.disabled = true;
		setStatus(loginStatus, "Account sign-in is not connected yet. Supabase project settings are required before launch.", "error");
		return;
	}

	supabaseClient = window.supabase.createClient(config.url, config.publishableKey);

	loginForm.addEventListener("submit", async (event) => {
		event.preventDefault();
		loginButton.disabled = true;
		setStatus(loginStatus, "Sending your secure sign-in link…");
		const email = new FormData(loginForm).get("email").toString().trim();
		const { error } = await supabaseClient.auth.signInWithOtp({
			email,
			options: { emailRedirectTo: new URL("/account/", window.location.origin).toString() }
		});
		loginButton.disabled = false;
		if (error) {
			console.error("Could not send sign-in link", error);
			setStatus(loginStatus, "We couldn’t send the sign-in link. Please check the address and try again.", "error");
			return;
		}
		setStatus(loginStatus, "Check your email for a secure sign-in link.");
	});

	document.getElementById("sign-out-button").addEventListener("click", async () => {
		const { error } = await supabaseClient.auth.signOut();
		if (error) setStatus(dashboardStatus, "Could not sign out. Please try again.", "error");
	});

	supabaseClient.auth.onAuthStateChange((_event, session) => {
		if (session?.user) {
			void loadDashboard(session.user);
		} else {
			showSignedOut();
		}
	});

	supabaseClient.auth.getSession().then(({ data, error }) => {
		if (error) {
			showSignedOut("Your sign-in session couldn’t be checked. Please try again.");
			return;
		}
		if (data.session?.user) void loadDashboard(data.session.user);
	});
})();
