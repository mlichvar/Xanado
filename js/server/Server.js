/* See README.md at the root of this distribution for copyright and
   license information */
/* eslint-env amd, node */

define('server/Server', [
	'fs', 'node-getopt', 'events',
	'socket.io', 'http', 'https', 'nodemailer', "cors",
	'express', 'express-negotiate', 'errorhandler',
	'platform', 'server/UserManager',
	'game/Fridge', 'game/Game', 'game/Player', 'game/Edition'
], (
	fs, Getopt, Events,
	SocketIO, Http, Https, NodeMailer, cors,
	Express, ExpressNegotiate, ErrorHandler,
	Platform, UserManager,
	Fridge, Game, Player, Edition
) => {

	const Fs = fs.promises;

	/**
	 * Generic catch for response handlers
	 * @param {Error} e the error
	 * @param {Request} req the request object
	 * @param {Response} res the response object
	 * @param {string?} context context of the failure
	 * @private
	 */
	function trap(e, req, res) {
		if (typeof e === 'object' && e.code === 'ENOENT') {
			// Special case of a database file load failure
			console.debug(`<-- 404 ${req.url}`);
			res.status(404).send([
				/*i18n*/"Load failed", req.url]);
		} else {
			console.debug("<-- 500 ", e);
			res.status(500).send(e);
		}
	}

	/**
	 * Web server for crossword game.
	 */
	class Server {

		/**
		 * @param {Object} config See example-config.json for content
		 */
		constructor(config) {
			this.config = config;
			this.db = new Platform.Database('games', 'game');
			// Live games; map from game key to Game
			this.games = {};
			// Status-monitoring sockets (game pages)
			this.monitors = [];

			process.on('unhandledRejection', reason => {
				console.error('Command rejected', reason, reason ? reason.stack : "");
			});

			const express = new Express();

			// Headers not added by passport?
			express.use(cors());

			// Parse incoming requests with url-encoded payloads
			express.use(Express.urlencoded({ extended: true }));

			// Parse incoming requests with a JSON body
			express.use(Express.json());

			// Grab all static files relative to the project root
			// html, images, css etc. The Content-type should be set
			// based on the file mime type (extension) but Express doesn't
			// always get it right.....
			console.log(`static files from ${requirejs.toUrl('')}`);
			express.use(Express.static(requirejs.toUrl('')));

			express.use((req, res, next) => {
				console.debug(`--> ${req.method} ${req.url}`);
				next();
			});

			// Add user manager routes (/login, /register etc.
			this.userManager = new UserManager(config, express);

			//DEBUG
			//express.use((req, res, next) => {
			//	if (req.isAuthenticated())
			//		console.debug(`\tuser ${req.user.name}`);
			//next();
			//});

			// Create a router for game commands
			const cmdRouter = Express.Router();

			// Get the HTML for the main interface (the "games" page)
			cmdRouter.get('/',
					   (req, res) => res.sendFile(
						   requirejs.toUrl('html/games.html')));

			// Get a simplified version of games list or a single game
			// (no board, bag etc) for the "games" page. You can request
			// "active" games (those still in play), "all" games (for
			// finished games too), or a single game key
			cmdRouter.get('/simple/:send',
					   (req, res) => this.request_simple(req, res));

			// Get a games history. Sends a summary of cumulative player
			// scores to date, for each unique player.
			cmdRouter.get('/history',
					   (req, res) => this.request_history(req, res));

			// Get a list of available locales
			cmdRouter.get('/locales',
					(req, res) => this.request_locales(req, res));

			// Get a list of of available editions
			cmdRouter.get('/editions',
					 (req, res) => this.request_editions(req, res));

			// Get a description of the available dictionaries
			cmdRouter.get('/dictionaries',
					 (req, res) => this.request_dictionaries(req, res));

			// Get a description of defaults for new games
			cmdRouter.get('/defaults', (req, res) =>
					 res.send({
						 edition: config.defaultEdition,
						 dictionary: config.defaultDictionary,
						 canEmail: typeof config.mail !== 'undefined'
					 }));

			// Get Game. This is a full description of the game, including
			// the Board. c.f. /simple which provides a cut-down version
			// of the same thing.
			cmdRouter.get('/game/:gameKey',
					 (req, res) => this.request_game(req, res));

			// Request handler for best play hint. Allows us to pass in
			// any player key, which is useful for debug (though could
			// be used to silently cheat!)
			cmdRouter.get('/bestPlay/:gameKey/:playerKey',
						(req, res, next) =>
						this.userManager.checkLoggedIn(req, res, next),
					   (req, res) => this.request_bestPlay(req, res));

			// Construct a new game. games.js
			cmdRouter.post('/createGame',
						   (req, res, next) =>
						   this.userManager.checkLoggedIn(req, res, next),
						   (req, res) => this.request_createGame(req, res));

			// Invite players by email
			cmdRouter.post('/invitePlayers',
						   (req, res, next) =>
						   this.userManager.checkLoggedIn(req, res, next),
						   (req, res) => this.request_invitePlayers(req, res));

			// Delete an active or old game. Invoked from games.js
			cmdRouter.post('/deleteGame/:gameKey',
						(req, res, next) =>
						this.userManager.checkLoggedIn(req, res, next),
						(req, res) => this.request_deleteGame(req, res));

			// Request another game in a series
			// Note this is NOT auth-protected, it is invoked
			// from the game interface to create a follow-on game
			cmdRouter.post('/anotherGame/:gameKey',
						(req, res, next) =>
						this.userManager.checkLoggedIn(req, res, next),
						(req, res) => this.request_anotherGame(req, res));

			// send email reminders about active games
			cmdRouter.post('/sendReminder/:gameKey',
						(req, res, next) =>
						this.userManager.checkLoggedIn(req, res, next),
						(req, res) => this.request_sendReminder(req, res));

			// Handler for player joining a game
			cmdRouter.post('/join/:gameKey/:playerKey',
					   (req, res, next) =>
					   this.userManager.checkLoggedIn(req, res, next),
					   (req, res) => this.request_join(req, res));

			// Handler for player leaving a game
			cmdRouter.post('/leave/:gameKey/:playerKey',
					   (req, res, next) =>
					   this.userManager.checkLoggedIn(req, res, next),
					   (req, res) => this.request_leave(req, res));

			// Handler for adding a robot to a game
			cmdRouter.post('/addRobot',
					   (req, res, next) =>
					   this.userManager.checkLoggedIn(req, res, next),
					   (req, res) => this.request_addRobot(req, res));

			// Request handler for a turn (or other game command)
			cmdRouter.post('/command/:command/:gameKey/:playerKey',
						(req, res, next) =>
						this.userManager.checkLoggedIn(req, res, next),
						(req, res) => this.request_command(req, res));

			express.use(cmdRouter);

			express.use((err, req, res, next) => {
				if (res.headersSent) {
					return next(err);
				}
				console.debug("<-- 500 (unhandled)", err);
				res.status(500).send(err);
				return res.status(err.status || 500);
			});

			express.use(ErrorHandler({
				dumpExceptions: true,
				showStack: true
			}));

			const http = config.https
				  ? Https.Server(config.https, express)
				  : Http.Server(express);

			http.listen(config.port);

			const io = new SocketIO.Server(http);
			io.sockets.on(
				'connection', socket => this.attachSocketHandlers(socket));
		}

		/**
		 * Load the game from the DB, if not already in server memory
		 * @param {string} key game key
		 * @return {Promise} Promise that resolves to a {@link Game}
		 */
		loadGame(key) {
			if (this.games[key])
				return Promise.resolve(this.games[key]);

			return this.db.get(key, Game.classes)
			.then(game => game.onLoad(this.db))
			.then(game => game.checkTimeout())
			.then(game => {
				Events.EventEmitter.call(game);

				Object.defineProperty(
					// makes connections non-persistent
					game, 'connections', { enumerable: false });
				this.games[key] = game;

				if (game.hasEnded())
					return game;

				const player = game.getPlayer();
				if (player)
					game.playIfReady();
				return game;
			});
		}

		/**
		 * Attach the handlers for incoming socket messages from the UI
		 * @param {socket.io} socket the socket to listen to
		 */
		attachSocketHandlers(socket) {
			socket

			.on('monitor', () => {
				// Games monitor has joined
				console.debug('-S-> monitor');
				this.monitors.push(socket);
			})

			.on('connect', sk => {
				console.debug('-S-> connect');
				this.updateMonitors();
			})

			.on('disconnect', sk => {
				console.debug('-S-> disconnect');

				// Don't need to find the Game using this socket, because
				// each Game has a 'disconnect' listener on each of the
				// sockets being used. However monitors don't.

				// Remove any monitor using this socket
				const i = this.monitors.indexOf(socket);
				if (i >= 0) {
					// Game monitor has disconnected
					console.debug('Monitor disconnected');
					this.monitors.slice(i, 1);
				} else {
					console.debug('Anonymous disconnect');
					this.updateMonitors();
				}
			})

			.on('join', params => {
				// Player joining
				console.debug(`-S-> join ${params.playerKey} joining ${params.gameKey}`);
				this.loadGame(params.gameKey)
				.then(game => {
					game.connect(socket, params.playerKey);
					this.updateMonitors();
				});
			})

			.on('message', message => {

				// Chat message
				console.debug(`-S-> ${message}`);
				if (message.text === 'hint')
					socket.game.hint(socket.player);
				else if (message.text === 'advise')
					socket.game.toggleAdvice(socket.player);
				else
					socket.game.notifyPlayers('message', message);
			});
		}

		/**
		 * Notify monitors that something has changed.
		 * The monitors will issue requests to determine what changed.
		 */
		updateMonitors() {
			this.monitors.forEach(socket => socket.emit('update'));
		}

		/**
		 * Before processing a Move instruction (pass or play) check that
		 * the game is ready to accept a Turn from the given player.
		 * @param {Player} player - Player to check
		 * @param {Game} game - Game to check
		 */
		checkTurn(player, game) {
			if (game.hasEnded()) {
				console.error(`Game ${game.key} has ended ${game.state}`);
				throw new Error(/*i18n*/'Game has ended');
			}

			// determine if it is this player's turn
			if (player.key !== game.whosTurnKey) {
				console.error(`not ${player.name}'s turn`);
				throw new Error(/*i18n*/'Not your turn');
			}
		}

		/**
		 * Sends a simple description of active games (optionally with
		 * completed games). Only parameter is 'send' which can be set
		 * to a single game key to get a single game, 'active' to get
		 * active games, or 'all' to get all games, including finished
		 * games. Note: this sends Game.simple objects, not Game objects.
		 * @return {Promise} Promise to send a list of games as requested
		 */
		request_simple(req, res) {
			const server = this;
			const send = req.params.send;
			// Make list of keys we are interested in
			return ((send === 'all' || send === 'active')
				? this.db.keys()
				: Promise.resolve([send]))
			// Load those games
			.then(keys => Promise.all(keys.map(key => this.loadGame(key))))
			// Filter the list and generate simple data
			.then(games => Promise.all(
				games
				.filter(game => (send !== 'active' || !game.hasEnded()))
				.map(game => game.simple(this.userManager))))
			// Sort the resulting list by last activity, so the most
			// recently active game bubbles to the top
			.then(gs => gs.sort((a, b) => a.lastActivity < b.lastActivity ? 1
								: a.lastActivity > b.lastActivity ? -1 : 0))
			// Finally send the result
			.then(data => {
				console.debug(`<-- 200 simple ${send}`);
				res.status(200).send(data);
			})
			.catch(e => {
				console.debug("<-- 500", e);
				res.status(500).send([
					/*i18n*/"Game load failed", e.toString()]);
			});
		}

		/**
		 * Handler for GET /history
		 * Sends a summary of cumulative player scores to date, for all
		 * unique players.
		 * @return {Promise}
		 */
		request_history(req, res) {
			const server = this;

			return this.db.keys()
			.then(keys => keys.map(key => this.loadGame(key)))
			.then(promises => Promise.all(promises))
			.then(games => {
				const results = {};
				games
				.filter(game => game.hasEnded())
				.map(game => {
					const winScore = game.winningScore();
					game.players.map(
						player => {
							let result = results[player.key];
							if (!result) {
								results[player.key] =
								result = {
									key: player.key,
									name: player.name,
									score: 0,
									wins: 0,
									games: 0
								};
							}
							result.games++;
							if (player.score === winScore)
								result.wins++;
							result.score += player.score;
						});
				});
				const list = [];
				for (let name in results)
					list.push(results[name]);
				return list;
			})
			.then(list => list.sort((a, b) => a.score < b.score ? 1
									: (a.score > b.score ? -1 : 0)))
			.then(list => res.status(200).send(list))
			.catch(e => trap(e, req, res));
		}

		/**
		 * Handler for GET /locales
		 * Sends a list of available locales.  Used when selecting a
		 * presentation language for the UI.
		 * @return {Promise} Promise to list locales
		 */
		request_locales(req, res) {
			const db = new Platform.Database('i18n', 'json');
			return db.keys()
			.then(keys => {
				res.status(200).send(keys);
			})
			.catch(e => trap(e, req, res));
		}

		/**
		 * Handler for GET /editions
		 * Promise to get an index of available editions.
		 * return {Promise} Promise to index available editions
		 */
		request_editions(req, res) {
			const db = new Platform.Database('editions', 'js');
			return db.keys()
			.then(editions => res.status(200).send(
				editions
				.filter(e => !/^_/.test(e))))
			.catch(e => trap(e, req, res));
		}

		/**
		 * Handler for GET /dictionaries
		 * return {Promise} Promise to index available dictionaries
		 */
		request_dictionaries(req, res) {
			const db = new Platform.Database('dictionaries', 'dict');
			return db.keys()
			.then(keys => res.status(200).send(keys))
			.catch(e => trap(e, req, res));
		}

		/**
		 * Handler for POST /createGame
		 * @return {Promise}
		 */
		request_createGame(req, res) {
			let minPlayers = req.body.minPlayers;
			let maxPlayers = req.body.maxPlayers;

			return Edition.load(req.body.edition)
			.then(edition => new Game(req.body).create())
			.then(game => game.onLoad(this.db))
			.then(game => {
				console.log(game.toString());

				// Save the game when everything has been initialised
				return game.save();
			})
			.then(game => res.status(200).send(game.key));
		}

		/**
		 * @param {object} to a lookup suitable for use with UserManager.getUser
		 * @param {object} req request
		 * @param {object} res response
		 * @param {string} gameKey game to which this applies
		 * @param {string} subject subject
		 * @param {string} text email text
		 * @param {string} html email html
		 * @return {Promise} Promise that resolves to the user that was mailed,
		 * either their game name or their email if there is no game name.
		 * @private
		 */
		sendMail(to, req, res, gameKey, subject, text, html) {
			return this.userManager.getUser(
				{key: req.session.passport.user.key})
			.then(sender => `${sender.name}<${sender.email}>`)
			.catch(e => this.config.email.sender)
			.then(sender =>
				new Promise(
					resolve => this.userManager.getUser(to, true)
					.catch(e => {
						// Not a known user, rely on email in the
						// getUser query
						resolve({
							name: to.email, email: to.email
						});
					})
					.then(uo => resolve(uo)))
				.then(uo => {
					if (!uo.email) // no email
						return Promise.resolve(
							Platform.i18n('($1 has no email address)',
										  uo.name || uo.key));
					console.debug(
						subject,
						`${uo.name}<${uo.email}> from `,
						sender);
					return this.config.mail.transport.sendMail({
						from: sender,
						to: uo.email,
						subject: subject,
						text: text,
						html: html
					})
					.then(() => uo.name || uo.email);
				}));
		}

		/**
		 * Handle /invitePlayers
		 * @return {Promise}
		 */
		request_invitePlayers(req, res) {
			if (!this.config.mail || !this.config.mail.transport) {
				res.status(500).send('Mail is not configured');
				return Promise.reject();
			}
			if (!req.body.player) {
				res.status(500).send('Nobody to notify');
				return Promise.reject();
			}

			const gameURL =
				  `${req.protocol}://${req.get('Host')}/html/games.html?untwist=${req.body.gameKey}`;

			let textBody = req.body.message || "";
			if (textBody)
				textBody += "\n";
			textBody += Platform.i18n(
				"Join the game by following this link: $1", gameURL);

			// Handle XSS risk posed by HTML in the textarea
			let htmlBody = req.body.message.replace(/</g, '&lt;') || "";
			if (htmlBody)
				htmlBody += "<br/>";
			htmlBody += Platform.i18n(
				"Click <a href='$1'>here</a> to join the game.", gameURL);
			
			return Promise.all(req.body.player.map(
				to => this.sendMail(
					to, req, res, req.body.gameKey,
					Platform.i18n("You have been invited to play XANADO"),
					textBody,
					htmlBody)))
			.then(list => {
				console.log("Invited", list);
				const names = list.filter(uo => uo);
				console.debug("<-- 200 ", names);
				res.status(200).send([
					/*i18n*/"Invited $1", names.join(", ")]);
			})
			.catch(e => trap(e, req, res));
		}

		/**
		 * Handler for POST /sendReminder
		 * Email reminders to next human player in (each) game
		 */
		request_sendReminder(req, res) {
			const gameKey = req.params.gameKey;
			console.log('Sending turn reminders');
			const gameURL =
				  `${req.protocol}://${req.get('Host')}/game/${gameKey}`;

			const prom = (gameKey === '*')
				  ? this.db.keys() : Promise.resolve([gameKey]);
			return prom
			.then(keys => Promise.all(keys.map(
				key => (Promise.resolve(this.games[key])
						|| this.db.get(key, Game.classes))
				.then(game => {
					const pr = game.checkTimeout();
					if (game.state !== 'playing')
						return undefined;

					const player = game.getPlayer();
					console.log(`Sending reminder mail to ${player.key}/${player.name}`);

					return this.sendMail(
						player, req, res, game.key,
						Platform.i18n(
							'It is your turn in your XANADO game'),
						Platform.i18n(
							"Join the game by following this link: $1",
							gameURL),
						Platform.i18n(
							"Click <a href='$1'>here</a> to join the game.",
							gameURL));
				}))))
			.then(reminders => reminders.filter(e => typeof e !== 'undefined'))
			.then(reminders=> {
				console.debug("Reminded ", reminders);
				return res.status(200).send(
					[/*i18n*/'Reminded $1', reminders.join(', ')]);
			})
			.catch(e => trap(e, req, res));
		}

		/**
		 * Handle /join/:gameKey player joining a game.
		 * @return {Promise}
		 */
		request_join(req, res) {
			const gameKey = req.params.gameKey;
			return this.loadGame(gameKey)
			.then(game => {
				// Player is either joining or connecting
				const playerKey = req.user.key;
				let player = game.getPlayerWithKey(playerKey), prom;
				if (player) {
					console.log(`Player ${playerKey} opening ${gameKey}`);
					prom = Promise.resolve(game);
				} else {
					console.log(`Player ${playerKey} joining ${gameKey}`);
					player = new Player(
						{
							name: req.user.name, key: playerKey
						},
						() => req.user.email
					);
					game.addPlayer(player);
					prom = game.save();
				}
				// The game may now be ready to start
				return prom.then(game => game.playIfReady());
			})
			.then(() => res.status(200).send({
				gameKey: gameKey,
				playerKey: req.user.key
			}))
			.catch(e => trap(e, req, res));
		}

		/**
		 * Handle /addRobot/:gameKey to add a robot to the game
		 * It's an error to add a robot to a game that already has a robot.
		 * @return {Promise}
		 */
		request_addRobot(req, res) {
			const gameKey = req.body.gameKey;
			const dic = req.body.dictionary;
			const canChallenge = req.body.canChallenge;
			console.debug("Add robot",req.body);
			return this.loadGame(gameKey)
			.then(game => {
				if (game.hasRobot())
					return res.status(500).send("Game already has a robot");
				console.log(`Robot joining ${gameKey} with ${dic}`);
				// Robot always has the same player key
				const robot = new Player(
					{
						name: "Robot",
						key: UserManager.ROBOT_KEY,
						isRobot: true,
						canChallenge: canChallenge
					});
				if (dic && dic !== 'none')
					robot.dictionary = dic;
				game.addPlayer(robot);
				return game.save()
				// Game may now be ready to start
				.then(game => game.playIfReady())
				.then(mess => res.status(200)
					  .send(mess || 'Robot'));
			})
			.catch(e => trap(e, req, res));
		}

		/**
		 * Handle /leave/:gameKey player leaving a game.
		 * @return {Promise}
		 */
		request_leave(req, res) {
			const gameKey = req.params.gameKey;
			const playerKey = req.params.playerKey;
			return this.loadGame(gameKey)
			.then(game => {
				console.log(`Player ${playerKey} leaving ${gameKey}`);
				const player = game.getPlayerWithKey(playerKey);
				if (player) {
					game.removePlayer(player);
					return game.save()
					.then(() => {
						this.updateMonitors();
						return res.status(200).send(
							{ gameKey: gameKey, playerKey: playerKey });
					});
				}
				return res.status(500).send([
					/*i18n*/"Player $1 is not in game $2", playerKey, gameKey
				]);
			})
			.catch(e => trap(e, req, res));
		}

		/**
		 * Handle /game/:gameKey request for a dump of the game information.
		 * This sends the entire Game object, including the entire Turn history
		 * and the Board
		 * @return {Promise}
		 */
		request_game(req, res) {
			const gameKey = req.params.gameKey;
			return this.db.get(gameKey, Game.classes)
			.then(game => res.status(200).send(Fridge.freeze(game)))
			.catch(e => trap(e, req, res));
		}

		/**
		 * Handle /bestPlay/:gameKey/:playerKey
		 * Find the best play for the player, given the current board
		 * state. Note that it may not be their turn, that's OK, this is debug
		 * @return {Promise}
		 */
		request_bestPlay(req, res) {
			const gameKey = req.params.gameKey;
			const playerKey = req.params.playerKey;
			return this.loadGame(gameKey)
			.then(game => {
				const player = game.getPlayerWithKey(playerKey);
				if (player)
					return Platform.findBestPlay(game, player.rack.tiles);
				return res.status(500).send([
					/*i18n*/"Player $1 is not in game $2", playerKey, gameKey
				]);
			})
			.then(play => res.status(200).send(Fridge.freeze(play)))
			.catch(e => trap(e, req, res));
		}

		/**
		 * Handle /deleteGame/:gameKey
		 * Delete a game.
		 * @return {Promise}
		 */
		request_deleteGame(req, res) {
			const gameKey = req.params.gameKey;
			console.log("Delete game",gameKey);
			return this.loadGame(gameKey)
			.then(game => game.stopTimers())
			.then(() => this.db.rm(gameKey))
			.then(() => res.status(200).send(`${gameKey} deleted`))
			.catch(e => trap(e, req, res));
		}

		/**
		 * Create another game with the same players.
		 * @return {Promise}
		 */
		request_anotherGame(req, res) {
			return this.loadGame(req.params.gameKey)
			.then(game => {
				return game.anotherGame()
				.then(() => res.status(200).send(game.nextGameKey));
			})
			.catch(e => trap(e, req, res));
		}

		/**
		 * Result is always a Turn object, though the actual content
		 * varies according to the command sent.
		 * @return {Promise}
		 */
		request_command(req, res) {
			const command = req.params.command;
			const gameKey = req.params.gameKey;
			const playerKey = req.params.playerKey;
			//console.debug(`Handling ${command} ${gameKey} ${playerKey}`);
			return this.loadGame(gameKey)
			.then(game => {
				if (game.hasEnded())
					return Promise.resolve();

				const player = game.getPlayerWithKey(playerKey);
				if (!player)
					return res.status(500).send([
						/*i18n*/"Player $1 is not in game $2", playerKey, gameKey
					]);

				// The command name and arguments
				const args = req.body.args ? JSON.parse(req.body.args) : null;
				
				console.debug(`COMMAND ${command} player ${player.name} game ${game.key}`);

				let promise;
				switch (command) {

				case 'makeMove':
					this.checkTurn(player, game);
					promise = game.makeMove(args);
					break;

				case 'pass':
					this.checkTurn(player, game);
					promise = game.pass('pass');
					break;

				case 'swap':
					this.checkTurn(player, game);
					promise = game.swap(args);
					break;

				case 'challenge':
					this.checkTurn(player, game);
					promise = game.challenge();
					break;

				case 'takeBack':
					promise = game.takeBack('took-back');
					break;

				case 'confirmGameOver':
					promise = game.confirmGameOver('Game over');
					break;

				case 'pause': case 'unpause':
					promise = game.togglePause(player);
					break;

				default:
					throw Error(`unrecognized command: ${command}`);
				}

				return promise.then(
					turn =>	{
						if (turn)
							return game.finishTurn(turn); // turn taken
						return game.save(); // simple state change
					})
				.then(() => {
					//console.debug(`${command} command handled`);
					// Notify non-game monitors (games pages)
					this.updateMonitors();
					res.status(200).send("OK");
				});
			})
			.catch(e => trap(e, req, res));
		}
	}
		
	function mainProgram() {

		// Command-line arguments
		const cliopt = Getopt.create([
			['h', 'help', 'Show this help'],
			['c', 'config=ARG', 'Path to config file (default config.json)']
		])
			.bindHelp()
			.setHelp('Xanado server\n[[OPTIONS]]')
			.parseSystem()
			.options;

		// Load config.json
		Fs.readFile(cliopt.config || 'config.json')
		.then(json => JSON.parse(json))

		// Configure email
		.then(config => {

			if (config.mail) {
				let transport;
				if (config.mail.transport === "mailgun") {
					if (!process.env.MAILGUN_SMTP_SERVER)
						console.error('mailgun configuration requested, but MAILGUN_SMTP_SERVER not defined');
					else {
						if (!config.mail.sender)
							config.mail.sender = `wordgame@${process.env.MAILGUN_DOMAIN}`;
						transport = {
							host: process.env.MAILGUN_SMTP_SERVER,
							port: process.env.MAILGUN_SMTP_PORT,
							secure: false,
							auth: {
								user: process.env.MAILGUN_SMTP_LOGIN,
								pass: process.env.MAILGUN_SMTP_PASSWORD
							}
						};
					}
				} else
					// Might be SMTP, might be something else
					transport = config.mail.transport;
				
				if (transport)
					config.mail.transport = NodeMailer.createTransport(
						transport);
			}

			const promises = [];
			if (config.https) {
				promises.push(
					Fs.readFile(config.https.key)
					.then(k => { config.https.key = k; }));
				promises.push(
					Fs.readFile(config.https.cert)
					.then(c => { config.https.cert = c; }));
			}
			return Promise.all(promises)
			.then(() => new Server(config));
		});
	}

	return mainProgram;
});
