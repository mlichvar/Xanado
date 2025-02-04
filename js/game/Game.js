/* See README.md at the root of this distribution for copyright and
   license information */
/* eslint-env amd */

define('game/Game', [
	'platform',
	'dawg/Dictionary',
	'game/GenKey', 'game/Board', 'game/Bag', 'game/LetterBag', 'game/Edition',
	'game/Player', 'game/Square', 'game/Tile', 'game/Rack', 'game/Move',
	'game/Turn'
], (
	Platform,
	Dictionary,
	GenKey, Board, Bag, LetterBag, Edition,
	Player, Square, Tile, Rack, Move,
	Turn
) => {

	function boolParam(val, defalt) {
		if (typeof val === "undefined")
			return defalt;
		if (typeof val === "string") {
			if (val === "0" || val === "" || val === "false") return false;
			return true;
		}
		if (typeof val === "number")
			return !isNaN(val) && val !== 0;
		return val;
	}

	function intParam(val, defalt) {
		if (typeof val === "undefined")
			return defalt;
		const i = parseInt(val);
		if (isNaN(i)) return defalt;
		return i;
	}

	/**
	 * The Game object may be used server or browser side.
	 */
	class Game {

		/**
		 * A new game is constructed from scratch by
		 * ```
		 * new Game(...).create().then(game => { game.onLoad(db)...
		 * ```
		 * A game identified by key is loaded from a db by
		 * ```
		 * db.get(key, Game.classes).then(game => { game.onLoad(db)...
		 * ```
		 * (may be null)
		 * @param {object} params Parameter object. This can be another
		 * Game to copy game parameters, the result from Game.simple(),
		 * or a generic object with these fields.
		 * @param {string} params.edition edition *name*, required
		 * @param {string?} params.dictionary *name* (may be null)
		 * @param {number?} params.secondsToPlay seconds allowed for plays
		 * @param {number?} params.minutesToPlay used if secondsToPlay
		 *  not given
		 * @param {boolean?} params.predictScore default true
		 * @param {boolean?} params.allowTakeBack default false
		 * @param {boolean?} params.checkDictionary default false
		 * @param {number?} params.minPlayers
		 * @param {number?} params.maxPlayers
		 */
		constructor(params) {
			this.debug = boolParam(params.debug, true);
			if (this.debug)
				console.debug("Constructing new game", params);

			/**
			 * Key that uniquely identifies this game
			 * @member {string}
			 */
			this.key = GenKey();

			/**
			 * Epoch ms when this game was created
			 * @member {number}
			 * @private
			 */
			this.creationTimestamp = Date.now();

			/**
			 * The name of the edition.
			 * We don't keep a pointer to the Edition object so we can
			 * cheaply serialise and send to the games interface. 
			 * @member {string}
			 */
			this.edition = params.edition;
			if (!this.edition)
				throw new Error("Game must have an edition");

			/**
			 * We don't keep a pointer to the dictionary objects so we can
			 * cheaply serialise and send to the games interface. We just
			 * keep the name of the relevant object.
			 * @member {string}
			 */
			this.dictionary =
			(params.dictionary && params.dictionary != "none") ?
			params.dictionary : null;

			/**
			 * An i18n message identifier, 'playing' until the game is finished
			 * @member {string}
			 */
			this.state = 'playing';

			/**
			 * List of Player
			 * @member {Player[]}
			 * @private
			 */
			this.players = [];

			/**
			 * Complete list of the turn history of this game
			 * List of Turn objects.
			 * @member {Turn[]}
			 */
			this.turns = [];

			/**
			 * Key of next player to play in this game
			 * @member {string}
			 */
			this.whosTurnKey = undefined;

			/**
			 * Time limit for a play in this game.
			 * Default 0 means never time out.
			 * @member {number}
			 */
			this.secondsPerPlay =
			intParam(params.secondsPerPlay) || (intParam(params.minutesPerPlay) || 0) * 60;

			/**
			 * Pointer to Board object
			 * @member {Board}
			 */
			this.board = null;

			/**
			 * Size of rack. Always the same as Edition.rackCount,
			 * cached because we don't hold a pointer to the Edition
			 * @member {number}
			 */
			this.rackSize = 0;

			/**
			 * LetterBag object
			 * @member {LetterBag}
			 */
			this.letterBag = undefined;

			/**
			 * Who paused the game (if it's paused)
			 * @member {string}
			 */
			this.pausedBy = undefined;

			/**
			 * Least number of players must have joined before this game
			 * can start. Must be at least 2.
			 * @member {number}
			 */
			this.minPlayers = intParam(params.minPlayers, 2);

			/**
			 * Most number of players who can join this game. 0 means no limit.
			 * @member {number}
			 */
			this.maxPlayers = intParam(params.maxPlayers, 0);
			if (this.maxPlayers < this.minPlayers)
				this.maxPlayers = 0;

			/**
			 * When a game is ended, nextGameKey is the key for the
			 * continuation game
			 * @member {string}
			 */
			this.nextGameKey = undefined;

			/**
			 * Whether or not to show the predicted score from tiles
			 * placed during the game. This should be false in tournament
			 * play, true otherwise.
			 * @member {boolean}
			 */
			this.predictScore = boolParam(params.predictScore, false);

			/**
			 * Whether or not to allow players to take back their most recent
			 * move without penalty, so long as the next player hasn't
			 * challenged or played.
			 * @member {boolean}
			 */
			this.allowTakeBack = boolParam(params.allowTakeBack, false);

			/**
			 * Whether or not to check the dictionary to report on the
			 * validity of the just player move.
			 * @member {boolean}
			 */
			this.checkDictionary = boolParam(params.checkDictionary, false);

			/**
			 * List of decorated sockets
			 * @member {WebSocket[]}
			 * @private
			 */
			this._connections = [];

			/**
			 * Database containing this game
			 * @member {Platform.Database}
			 * @private
			 */
			this._db = undefined;
		}

		/**
		 * Promise to finish construction of a new Game.
		 * Load the edition and create the board and letter bag.
		 * Not done in the constructor because we need to return
		 * a Promise.
		 * @return {Promise} that resolves to this
		 */
		create() {
			// Can't be done in the constructor because we want to
			// return a Promise. Extending Promise so that the constructor
			// return a Promise would be semantically confusing.
			return this.getEdition(this.edition)
			.then(edo => {
				this.board = new Board(edo);
				this.letterBag = new LetterBag(edo);
				this.rackSize = edo.rackCount;
				return this;
			});
		}

		/**
		 * A game loaded by deserialisation has to know what DB it was
		 * loaded from so it knows where to save the game. The
		 * database and connections are not serialised, and must be
		 * reset.
		 * @param {Platform.Database} db the db to use
		 * @return {Promise} Promise that resolves to the game
		 */
		onLoad(db) {
			this._connections = [];
			this._db = db;
			return Promise.resolve(this);
		}

		/**
		 * Add a player to the game, and give them an initial rack
		 * @param {Player} player
		 */
		addPlayer(player) {
			if (!this.letterBag)
				throw Error('Cannot addPlayer() before create()');
			if (this.maxPlayers > 1 && this.players.length === this.maxPlayers)
				throw Error('Cannot addPlayer() to a full game');			
			this.players.push(player);
			player.fillRack(
				this.letterBag,
				this.rackSize);
		}

		/**
		 * Remove a player from the game, taking their tiles back into
		 * the bag
		 * @param {Player} player
		 */
		removePlayer(player) {
			player.returnTiles(this.letterBag);
			const index = this.players.findIndex(p => p.key === player.key);
			if (index < 0)
				throw Error(`No such player ${player.key} in ${this.key}`);
			this.players.splice(index, 1);
			if (this.debug)
				console.debug(`${player.key} left ${this.key}`);
		}

		/**
		 * Get the player by key.
		 * @param {string} key key of player to get. If undefined, will
		 * return the current player
		 * @return {Player} player, or undefined if not found
		 */
		getPlayer(key) {
			if (typeof key === 'undefined')
				key = this.whosTurnKey;
			return this.players.find(p => p.key === key);
		}

		/**
		 * Get the last player before the given player, identified by key
		 * @param {string|Player} player the current player if undefined, or
		 * the player to get the previous player of
		 * @return {Player} previous player
		 */
		previousPlayer(player) {
			if (typeof player === 'undefined')
				player = this.getPlayer(this.whosTurnKey);
			else if (typeof player === 'string')
				player = this.getPlayer(player);
			if (!player)
				return undefined;
			const index = this.players.findIndex(p => p.key === player.key);
			if (index < 0)
				throw new Error(`${player.key} not found in ${this.key}`);
			return this.players[
				(index + this.players.length - 1) % this.players.length];
		}

		/**
		 * Get the next player after the given player
		 * @param {string|Player} player the current player if undefined,
		 * or the key of a player, or the player
		 * of the player to get the next player to
		 * @return {Player} the next player
		 */
		nextPlayer(player) {
			if (typeof player === 'undefined')
				player = this.getPlayer(this.whosTurnKey);
			else if (typeof player === 'string')
				player = this.getPlayer(player);
			const index = this.players.findIndex(p => p.key === player.key);
			if (index < 0)
				throw new Error(`${player.key} not found in ${this.key}`);
			return this.players[(index + 1) % this.players.length];
		}

		/**
		 * Get the player with key
		 * @param {string} player key
		 * @return {Player} player, or undefined if not found
		 */
		getPlayerWithKey(key) {
			return this.players.find(p => p.key === key);
		}

		/**
		 * Used for testing only.
		 * @param sboard string representation of a game {@link Board}
		 * @return {Promise} resolving to `this`
		 */
		loadBoard(sboard) {
			return this.getEdition(this.edition)
			.then(ed => this.board.parse(sboard, ed))
			.then(() => this);
		}

		/**
		 * Get the edition for this game, lazy-loading as necessary
		 * @return {Promise} resolving to an {@link Edition}
		 */
		getEdition() {
			return Edition.load(this.edition);
		}

		/**
		 * Get the dictionary for this game, lazy-loading as necessary
		 * @return {Promise} resolving to a {@link Dictionary}
		 */
		getDictionary() {
			if (this.dictionary)
				return Dictionary.load(this.dictionary);

			// Terminal, no point in translating
			return Promise.reject('Game has no dictionary');
		}

		/**
		 * Get the current winning score
		 * @return {number} points
		 */
		winningScore() {
			return this.players.reduce(
				(max, player) => Math.max(max, player.score), 0);
		}

		/**
		 * If there is a player with no tiles, return them.
		 * @return {Player} the player with no tiles, or undefined
		 */
		getPlayerWithNoTiles() {
			return this.players.find(
				player => (player.rack.tiles().length === 0));
		}

		/**
		 * Return true if the game state indicates the game has ended
		 */
		hasEnded() {
			return this.state !== 'playing';
		}

		/**
		 * Determine when the last activity on the game happened. This
		 * is either the last time a turn was processed, or the creation time.
		 * @return {number} a time in epoch ms
		 */
		lastActivity() {
			if (this.turns.length > 0)
				return this.turns[this.turns.length - 1].timestamp;

			return this.creationTimestamp;
		}

		/**
		 * Get the board square at [col][row]
		 * @return {Square} at col,row
		 */
		at(col, row) {
			return this.board.at(col, row);
		}

		/**
		 * Simple summary of the game, for console output
		 * @return {string} debug description
		 */
		toString() {
			const options = [];
			if (this.predictScore) options.push("P");
			if (this.checkDictionary) options.push("C");
			if (this.allowTakeBack) options.push("T");
			const ps = this.players.map(p => p.toString()).join(', ');
			return `Game ${options.join('')} ${this.key} edition "${this.edition}" dictionary "${this.dictionary}" players [ ${ps} ] next ${this.whosTurnKey}`;
		}

		/**
		 * Promise to save the game
		 * @return {Promise} that resolves to the game when it has been saved
		 */
		save() {
			if (!this._db) return Promise.resolve();
			if (this.debug)
				console.debug(`Saving game ${this.key}`);
			return this._db.set(this.key, this)
			.then(() => this);
		}

		/**
		 * Determine if any players are robots
		 */
		hasRobot() {
			return this.players.find(p => p.isRobot);
		}

		/**
		 * A playable game will have at least two players.
		 * @return {Promise} promise that resolves to an error message,
		 * or undefined if game is playable
		 */
		playIfReady() {
			if (this.debug)
				console.debug(`playIfReady ${this.key} ${this.whosTurnKey}`);
			if (this.players.length < this.minPlayers) {
				if (this.debug)
					console.debug("\tnot enough players");
				// Result is not used
				return Promise.resolve('Not enough players');
			}

			let prom;

			if (!this.whosTurnKey) {
				// Pick a random tile from the bag
				this.whosTurnKey = this.players[
					Math.floor(Math.random() * this.players.length)].key;
				prom = this.save();
			} else if (!this.getPlayer(this.whosTurnKey)) {
				// Player who's play it was must have left
				this.whosTurnKey = this.players[0].key;
				prom = this.save();
			} else
				prom = Promise.resolve();

			const player = this.getPlayer();
			if (this.debug)
				console.debug(`\tnext to play is ${player.name}`,
						player.secondsToPlay);
			if (player.isRobot) {
				if (this.debug)
					console.debug(`\tautoplay ${player.name}`);
				return prom.then(() => this.autoplay())
				// May autoplay next robot recursively
				.then(turn => this.finishTurn(turn));
			}
			return prom.then(() => undefined);
		}

		/**
		 * Send a message to just one player. Note that the player
		 * may be connected multiple times through different sockets.
		 * @param {Player} player
		 * @param {string} message to send
		 * @param {Object} data to send with message
		 */
		notifyPlayer(player, message, data) {
			if (this.debug)
				console.debug(`<-S- ${player.key} ${message}`, data);
			// Player may be connected several times
			this._connections.forEach(
				socket => {
					if (socket.player === player)
						socket.emit(message, data);
					return false;
				});
		}

		/**
		 * Broadcast a message to all players and monitors. Note that a player
		 * may be connected multiple times, through different sockets.
		 * @param {string} message to send
		 * @param {Object} data to send with message
		 */
		notifyPlayers(message, data) {
			if (this.debug)
				console.debug(`<-S- * ${message}`, data);
			this._connections.forEach(socket => socket.emit(message, data));
		}

		/**
		 * Wrap up after a command handler that is returning a Turn.
		 * Log the command, determine whether the game has ended,
		 * save state and notify game listeners.
		 * @param {Turn} turn the Turn to finish
		 * @return {Promise} that resolves when the game has been saved
		 * and players have been notified.
		 */
		finishTurn(turn) {
			turn.timestamp = Date.now();

			// store turn log
			this.turns.push(turn);

			return this.save()
			.then(() => {
				this.notifyPlayers('turn', turn);

				// if the game has ended, send notification.
				if (this.state !== 'playing') {
					//console.debug(`${this.key} '${this.state}'`);
					this.notifyPlayers(
						'gameOverConfirmed',
						{
							key: this.key,
							state: this.state
						});
					return Promise.resolve();
				}

				if (this.debug)
					console.debug(`Player ${this.whosTurnKey}'s turn`);
				const nextPlayer = this.getPlayer();
				if (nextPlayer.isRobot) {
					// Does a player have nothing on their rack? If
					// so, the game is over because the computer
					// will never challenge their play.
					const promise = this.getPlayerWithNoTiles()
						  ? this.confirmGameOver('Game over')
						  : this.autoplay();
					// May recurse if the player after is also a robot, but
					// the recursion will always stop when a human player
					// is reached, so never deep.
					return promise.then(turn => {
						return this.finishTurn(turn);
					});
				}

				nextPlayer.startTimer(
					this.secondsPerPlay,
					() => this.pass('timeout')
					.then(turn => this.finishTurn(turn)));

				return Promise.resolve();
			});
		}

		/**
		 * Check if the game has timed out due to inactivity.
		 * Stops timers and sets the state of the game if it has.
		 * @return {Promise} resolves to the game when timeout has been checked,
		 * and applied if the game is timed out
		 */
		checkTimeout() {
			// Take the opportunity to time out old games
			const ageInDays =
				  (Date.now() - this.lastActivity())
				  / 60000 / 60 / 24;

			if (ageInDays <= 14)
				return Promise.resolve(this);

			if (this.debug)
				console.debug('Game timed out:',
						this.players.map(({ name }) => name));

			this.stopTimers();
			this.state = /*i18n*/'Timed out';
			return this.save();
		}

		/**
		 * Does player have an active connection to this game?
		 * @param {Player} player the player
		 * @return {WebSocket} a decorated socket, or null if not connected.
		 */
		getConnection(player) {
			for (let socket of this._connections) {
				if (socket.player === player)
					return socket;
			}
			return null;
		}

		/**
		 * Notify players with a list of the currently connected players,
		 * as identified by their key.
		 */
		updateConnections() {
			Promise.all(
				this._connections
				.filter(socket => socket.player instanceof Player)
				.map(socket => socket.player.simple(this)
					 .then(cat => {
						 cat.gameKey = this.key;
						 return cat;
					 })))
			.then(res => this.notifyPlayers('connections', res));
		}

		/**
		 * Start the turn of the given player.
		 * @param {Player} player the the player to get the turn
		 * @param {number} timeout timeout for this turn, if undefined, use
		 * the Game.secondsPerPlay
		 */
		startTurn(player, timeout) {
			if (this.debug)
				console.debug(`Starting ${player.name}'s turn`);
			this.whosTurnKey = player.key;
			if (this.secondsPerPlay && this.state !== 'playing') {
				if (this.debug)
					console.debug(`\ttimeout ${timeout || this.secondsPerPlay}`);
				player.startTimer(
					timeout || this.secondsPerPlay,
					() => this.pass('timeout')
					.then(turn => this.finishTurn(turn)));
			}
		}

		/**
		 * Create a simple structure describing a subset of the
		 * game state, for sending to the 'games' interface
		 * @param {UserManager} um user manager object for getting emails; only
		 * works on server side
		 * @return {Promise} resolving to a simple object with key game data
		 */
		simple(um) {
			return Promise.all(
				this.players.map(player => player.simple(this, um)))
			.then(ps => {
				return {
					key: this.key,
					creationTimestamp: this.creationTimestamp,
					edition: this.edition,
					dictionary: this.dictionary,
					predictScore: this.predictScore,
					checkDictionary: this.checkDictionary,
					allowTakeBack: this.allowTakeBack,
					state: this.state,
					players: ps,					
					turns: this.turns.length, // just the length
					whosTurnKey: this.whosTurnKey,
					secondsPerPlay: this.secondsPerPlay,
					// this.board is not sent
					// rackSize not sent, it's just a cache
					pausedBy: this.pausedBy,
					minPlayers: this.minPlayers,
					maxPlayers: this.maxPlayers,
					nextGameKey: this.nextGameKey,
					lastActivity: this.lastActivity() // epoch ms
				};
			});
		}

		/**
		 * Player is on the given socket, as determined from an incoming
		 * 'join'. Server side only.
		 * @param {WebSocket} socket the connecting socket
		 * @param {string} playerKey the key identifying the player
		 */
		connect(socket, playerKey) {

			// Make sure this is a valid (known) player
			const player = this.players.find(p => p.key === playerKey);
			if (!player) {
				console.error(`WARNING: player key ${playerKey} not found in game ${this.key}`);
			}

			const knownSocket = this.getConnection(player);
			if (knownSocket !== null) {
				console.error('WARNING:', player.key, 'already connected to',
							this.key);
			} else if (player && player.key === this.whosTurn
					   && this.state === 'playing') {
				// This player is just connecting, perhaps for the first time.
				// Start their timer.
				const to = (player.secondsToPlay > 0)
					  ? player.secondsToPlay
					  : this.secondsPerPlay;
				if (this.debug)
					console.debug(`${player.name} connected to ${this.key}`,
						   player.secondsToPlay);
				player.startTimer(
					to,
					() => this.pass('timeout')
					.then(turn => this.finishTurn(turn)));
			}

			// Player is connected. Decorate the socket. It may seem
			// rather cavalier, writing over the socket this way, but
			// it does simplify the code quite a bit.
			socket.game = this;
			socket.player = player;

			this._connections.push(socket);
			if (this.debug)
				console.debug(player ? `${player} connected` : "Anonymous connect()");

			// Tell players that the player is connected
			this.updateConnections();

			if (this.state === 'playing') {
				if (this.allPlayersReady()) {
					this.startTheClock();
					this.playIfReady();
				} else
					this.tick();
			}

			// Add disconnect listener
			socket.on('disconnect', () => {
				if (this.debug)
					console.debug(socket.player
							? `${socket.player.toString()} disconnected`
							: "Anonymous disconnect");
				this._connections = this._connections.filter(
					sock => sock !== socket);
				this.updateConnections();
			});
		}

		/**
		 * Server side, tell all clients a tick has happened
		 * @private
		 */
		tick() {
			const player = this.getPlayer();
			//if (this.debug) console.debug(`Tick ${this.getPlayer().name} ${player.secondsToPlay}`);
			if (!player)
				return;
			player.secondsToPlay--;
			this.notifyPlayers(
				'tick',
				{
					gameKey: this.key,
					playerKey: player.key,
					secondsToPlay: player.secondsToPlay
				});
		}

		/**
		 * Return true if the game is 'live' - all players connected
		 * @private
		 */
		allPlayersReady() {
			for (let player of this.players) {
				if (!player.isRobot && this.getConnection(player) === null)
					return false;
			}
			return true;
		}

		/**
		 * If the game has a time limit, start an interval timer to
		 * notify players of the remaining time for the player
		 * who's turn it is.
		 * @private
		 */
		startTheClock() {
			if (this.secondsPerPlay && !this._intervalTimer) {
				const rem = this.getPlayer().secondsToPlay;
				if (this.debug)
					console.debug(`Started tick timer with ${rem} on the clock`);
				// Broadcast a ping every second
				this._intervalTimer = setInterval(() => {
					const pnext = this.getPlayer();
					if (pnext && pnext.secondsToPlay > 0)
						this.tick();
				}, 1000);
			}
		}

		/**
		 * Stop the interval timer, if there is one
		 * @private
		 */
		stopTheClock() {
			if (this._intervalTimer) {
				if (this.debug)
					console.debug('Stopping tick timer');
				clearInterval(this._intervalTimer);
				this._intervalTimer = null;
			}
		}

		/**
		 * Stop player and game timeout timers
		 */
		stopTimers() {
			if (this.debug)
				console.debug("Stopping timers");
			this.stopTheClock();
			this.players.forEach(player => player.stopTimer());
		}

		/**
		 * Restart timers (game timeout timer and player timers) stopped in
		 * stopTimers()
		 */
		restartTimers() {
			if (this.debug)
				console.debug("Restarting timers");
			this.startTheClock();
			this.players.forEach(player => player.startTimer());
		}

		/**
		 * Check if the game is ended. This is done after any turn
		 * that could result in an end-of-game state i.e. 'makeMove',
		 * 'pass'.
		 * @private
		 * @return true if all players have passed twice
		 */
		allPassedTwice() {
			// determine whether the end has been reached
			return !this.players.find(p => p.passes < 2);
		}

		/**
		 * Handler for 'hint' request. This is NOT a turn handler.
		 * Asynchronously calculate a play for the given player, and
		 * notify all players that they requested a hint.
		 * @param {Player} player to get a hint for
		 */
		hint(player) {
			if (this.debug)
				console.debug(`Player ${player.name} asked for a hint`);

			let bestPlay = null;
			Platform.findBestPlay(
				this, player.rack.tiles(), data => {
					if (typeof data === 'string') {
						if (this.debug)
							console.debug(data);
					}
					else
						bestPlay = data;
				})
			.then(() => {
				const hint = {
					sender: /*i18n*/'Advisor'
				};
				if (!bestPlay)
					hint.text = /*i18n*/"Can't find a play";
				else {
					if (this.debug)
						console.debug(bestPlay);
					const start = bestPlay.placements[0];
					hint.text = /*i18n*/"Hint";
					const words = bestPlay.words.map(w => w.word).join(',');
					hint.args = [
						words, start.row + 1, start.col + 1, bestPlay.score
					];
				}

				// Tell the requesting player the hint
				this.notifyPlayer(player, 'message', hint);
				
				// Tell *everyone* that they asked for a hint
				this.notifyPlayers('message', {
					sender: /*i18n*/"Advisor",
					text: /*i18n*/"$1 asked for a hint",
					classes: 'warning',
					args: [ player.name ]
				});
			})
			.catch(e => {
				console.error('Error', e);
				this.notifyPlayers('message', {
					sender: /*i18n*/"Advisor",
					text: e.toString() });
			});
		}

		/**
		 * Toggle wantsAdvice on/off (browser side only)
		 * @param {Player} player who is being toggled
		 */
		toggleAdvice(player) {
			player.toggleAdvice();
			this.notifyPlayer(
				player, 'message',
				{
					sender: /*i18n*/'Advisor',
					text: (player.wantsAdvice
						   ? /*i18n*/'Enabled'
						   : /*i18n*/'Disabled')
				});
			if (player.wantsAdvice)
				this.notifyPlayers('message', {
					sender: /*i18n*/"Advisor",
					text: /*i18n*/"$1 has asked for advice from the robot",
					classes: 'warning',
					args: [ player.name ]
				});
		}

		/**
		 * Advise player as to what better play they might have been
		 * able to make.
		 * @param {Player} player a Player
		 * @param {number} theirScore score they got from their play
		 * @return {Promise} resolving to a {@link Turn}
		 */
		advise(player, theirScore) {
			if (this.debug)
				console.debug(`Computing advice for ${player.name} > ${theirScore}`);

			let bestPlay = null;
			return Platform.findBestPlay(
				this, player.rack.tiles(), data => {
					if (typeof data === 'string') {
						if (this.debug)
							console.debug(data);
					} else
						bestPlay = data;
				})
			.then(() => {
				if (bestPlay && bestPlay.score > theirScore) {
					if (this.debug)
						console.debug(`Better play found for ${player.name}`);
					const start = bestPlay.placements[0];
					const words = bestPlay.words.map(w => w.word).join(',');
					const advice = {
						sender: /*i18n*/'Advisor',
						text: /*i18n*/"$1 at row $2 column $3 would have scored $4",
						args: [	words, start.row + 1, start.col + 1,
								bestPlay.score ]
					};
					this.notifyPlayer(player, 'message', advice);
					this.notifyPlayers('message', {
						sender: /*i18n*/"Advisor",
						text: /*i18n*/"$1 has received advice from the robot",
						classes: 'warning',
						args: [ player.name ]
					});
				} else
					if (this.debug)
						console.debug(`No better plays found for ${player.name}`);
			})
			.catch(e => {
				console.error('Error', e);
			});
		}

		/**
		 * Handler for 'makeMove' command.
		 * @param {Move} move a Move (or the spec of a Move)
		 * @return {Promise} resolving to a {@link Turn}
		 */
		async makeMove(move) {
			if (!(move instanceof Move))
				move = new Move(move);

			const player = this.getPlayer();
			player.stopTimer();

			if (this.debug)
				console.debug(move);
			//console.log(`Player's rack is ${player.rack}`);

			// Fire up a thread to generate advice and wait for it
			// to complete. We can't do this asynchronously because
			// the advice depends on the board state, which the move will
			// update while the advice is still being computed.
			if (player.wantsAdvice)
				await this.advise(player, move.score);

			const game = this;

			// Move tiles from the rack to the board
			move.placements.forEach(placement => {
				const tile = player.rack.removeTile(placement);
				const square = game.board.at(placement.col, placement.row);
				square.placeTile(tile, true);
			});

			player.score += move.score;

			// Get new tiles to replace those placed
			for (let i = 0; i < move.placements.length; i++) {
				const tile = this.letterBag.getRandomTile();
				if (tile) {
					player.rack.addTile(tile);
					move.addReplacement(tile);
				}
			}

			if (this.debug)
				console.debug('New rack', player.rack.toString());

			//console.debug('words ', move.words);

			if (this.checkDictionary && !player.isRobot) {
				// Asynchronously check word and notify player if it
				// isn't found.
				this.getDictionary()
				.then(dict => {
					for (let w of move.words) {
						if (this.debug)
							console.debug('Checking ',w);
						if (!dict.hasWord(w.word)) {
							// Only want to notify the player
							this.notifyPlayer(
								player, 'message',
								{
									sender: /*i18n*/'Advisor',
									text: /*i18n*/'$1 not found in $2',
									args: [ w.word, dict.name ]
								});
						}
					}
				})
				.catch((e) => {
					console.error('Dictionary load failed', e);
				});
			}

			// Record the move
			move.playerKey = player.key;
			move.remainingTime = player.remainingTime;
			this.previousMove = move;

			player.passes = 0;

			if (this.state === 'playing') {
				if (this.allPassedTwice()) {
					this.stopTimers();
					this.state = /*i18n*/"All players passed twice";
				} else
					this.startTurn(this.nextPlayer());
			}
			
			// Report the result of the turn
			const turn = new Turn(this, {
				type: 'move',
				playerKey: player.key,
				nextToGoKey: this.whosTurnKey,
				score: move.score,
				placements: move.placements,
				replacements: move.replacements,
				words: move.words
			});

			return Promise.resolve(turn);
		}
		
		/**
		 * Robot play for the next player. This may result in a challenge.
		 * @return {Promise} resolving to a {@link Turn}
		 */
		autoplay() {

			const player = this.getPlayer();
			if (this.debug)
				console.debug(`Autoplaying ${player.name}`);

			// Before making a robot move, consider challenging the last
			// player.
			// challenge is a Promise that will resolve to a Turn if a
			// challenge is made, or undefined otherwise.
			let challenge = Promise.resolve(undefined);;
			if (this.dictionary
				&& player.canChallenge
				&& this.previousMove) {
				const lastPlayer = this.getPlayer(this.previousMove.playerKey);
				// There's no point if they are also a robot, though
				// that should never arise in a "real" game where there can
				// only be one robot.
				if (!lastPlayer.isRobot) {
					// use game dictionary, not robot dictionary
					challenge = this.getDictionary()
					.then(dict => {
						const bad = this.previousMove.words
							  .filter(word => !dict.hasWord(word.word));
						if (bad.length > 0) {
							// Challenge succeeded
							if (this.debug) {
								console.debug(`Challenging ${lastPlayer.name}`);
								console.debug(`Bad Words: `, bad);
							}
							return this.takeBack('challenge-won');
						}
						return undefined;
					});
				}
			}

			return challenge
			.then(turn => {
				if (turn)
					return turn;
				let bestPlay = null;
				return Platform.findBestPlay(
					this, player.rack.tiles(),
					data => {
						if (typeof data === 'string') {
							if (this.debug)
								console.debug(data);
						} else {
							bestPlay = data;
							if (this.debug)
								console.debug('Best', bestPlay);
						}
					}, player.dictionary)
				.then(() => {
					if (bestPlay)
						return this.makeMove(bestPlay);

					if (this.debug)
						console.debug(`${player.name} can't play, passing`);
					return this.pass('passed');
				});
			});
		}

		/**
		 * Un/Pause the game
		 * @param {Player} player to play
		 * @return {Promise} resolving to nothing
		 */
		togglePause(player) {
			if (this.pausedBy) {
				if (this.debug)
					console.debug(`${player.name} has unpaused game`);
				this.restartTimers();
				this.notifyPlayers('unpause', {
					key: this.key,
					name: player.name
				});
				this.pausedBy = undefined;
			} else {
				this.pausedBy = player.name;
				if (this.debug)
					console.debug(`${this.pausedBy} has paused game`);
				this.stopTimers();
				this.notifyPlayers('pause', {
					key: this.key,
					name: player.name
				});
			}
			return Promise.resolve();
		}

		/**
		 * Called when the game has been confirmed as over - the player
		 * following the player who just emptied their rack has confirmed
		 * they don't want to challenge, or they have challenged and the
		 * challenge failed.
		 * @param {string} endState gives reason why game ended (i18n message id)
		 * @return {Promise} resolving to a {@link Turn}
		 */
		confirmGameOver(endState) {
			this.state = endState;

			if (this.debug)
				console.debug(`Confirming game over because ${endState}`);
			this.stopTimers();

			// When the game ends, each player's score is reduced by
			// the sum of their unplayed letters. If a player has used
			// all of his or her letters, the sum of the other players'
			// unplayed letters is added to that player's score.
			let playerWithNoTiles;
			let pointsRemainingOnRacks = 0;
			const deltas = {};
			this.players.forEach(player => {
				deltas[player.key] = 0;
				if (player.rack.isEmpty()) {
					if (playerWithNoTiles)
						throw Error('Found more than one player with no tiles when finishing game');
					playerWithNoTiles = player;
				}
				else {
					const rackScore = player.rack.score();
					player.score -= rackScore;
					deltas[player.key] -= rackScore;
					pointsRemainingOnRacks += rackScore;
					if (this.debug)
						console.debug(`${player.name} has ${rackScore} left`);
				} 
			});

			if (playerWithNoTiles) {
				playerWithNoTiles.score += pointsRemainingOnRacks;
				deltas[playerWithNoTiles.key] = pointsRemainingOnRacks;
				if (this.debug)
					console.debug(`${playerWithNoTiles.name} gains ${pointsRemainingOnRacks}`);
			}

			const turn = new Turn(this, {
				type: endState,
				playerKey: this.whosTurnKey,
				score: deltas
			});
			return Promise.resolve(turn);
		}

		/**
		 * Undo the last move. This might be as a result of a player request,
		 * or the result of a challenge.
		 * @param {string} type the type of the takeBack; 'took-back'
		 * or 'challenge-won'
		 * @return {Promise} Promise resolving to a {@link Turn}
		 */
		takeBack(type) {
			// The UI ensures that 'took-back' can only be issued by the
			// previous player.
			// SMELL: Might a comms race result in it being issued by
			// someone else?
			const previousMove = this.previousMove;
			const prevPlayer = this.getPlayer(previousMove.playerKey);

			delete this.previousMove;

			// Move tiles that were added to the rack as a consequence
			// of the previous move, back to the letter bag
			for (let newTile of previousMove.replacements) {
				const tile = prevPlayer.rack.removeTile(newTile);
				this.letterBag.returnTile(tile);
			}

			// Move placed tiles from the board back to the prevPlayer's rack
			for (let placement of previousMove.placements) {
				const boardSquare =
					  this.board.at(placement.col, placement.row);
				prevPlayer.rack.addTile(boardSquare.tile);
				boardSquare.placeTile(null);
			}
			prevPlayer.score -= previousMove.score;

			const challenger = this.whosTurnKey;
			if (type === 'took-back') {
				// A takeBack, not a challenge. Let that player go again,
				// but with just the remaining time from their move.
				this.startTurn(this.getPlayer(previousMove.playerKey),
							   previousMove.remainingTime);
			}
			// else a successful challenge, does not move the player on.
			// Timer was cancelled during the challenge, and needs to be
			// restarted.
			else {
				// A successful challenge restarts the timer for the challenger
				// player from the beginning
				this.startTurn(this.getPlayer(challenger));
			}

			const turn = new Turn(this, {
				type: type,
				playerKey: previousMove.playerKey,
				nextToGoKey: this.whosTurnKey,
				score: -previousMove.score,
				placements: previousMove.placements,
				replacements: previousMove.replacements,
				challengerKey: challenger
			});

			return Promise.resolve(turn);
		}

		/**
		 * Handler for 'pass' command.
		 * Player wants to (or has to) miss their move. Either they
		 * can't play, or challenged and failed.
		 * @param {string} type pass type, 'passed' or 'challenge-failed'
		 * @return {Promise} resolving to a {@link Turn}
		 */
		pass(type) {
			const passingPlayer = this.getPlayer();
			passingPlayer.stopTimer();
			delete this.previousMove;
			passingPlayer.passes++;

			if (this.allPassedTwice()) {
				this.stopTimers();
				return this.confirmGameOver(/*i18n*/"All players passed twice");
			} else
				this.startTurn(this.nextPlayer());

			return Promise.resolve(new Turn(
				this, {
					type: type,
					playerKey: passingPlayer.key,
					nextToGoKey: this.whosTurnKey
				}));
		}

		/**
		 * Handler for 'challenge' command.
		 * Check the words created by the previous move are in the dictionary
		 * @return {Promise} resolving to a {@link Turn}
		 */
		challenge() {
			// Cancel any outstanding timer until the challenge is resolved
			this.getPlayer().stopTimer();

			return this.getDictionary()
			.catch(() => {
				if (this.debug)
					console.debug('No dictionary, so challenge always succeeds');
				return this.takeBack('challenge-won');
			})
			.then(dict => {
				const bad = this.previousMove.words
					  .filter(word => !dict.hasWord(word.word));

				if (bad.length > 0) {
					// Challenge succeeded
					if (this.debug)
						console.debug("Bad Words: ", bad);
					return this.takeBack('challenge-won');
				}

				// challenge failed, this player loses their turn

				// Special case; if the challenged play would be the last
				// play (challenged player has no more tiles) then
				// it is game over. It is the last play if there were no
				// replacements.
				if (this.previousMove.replacements.length === 0) {
					return this.confirmGameOver(/*i18n*/"challenge-failed");
				}

				return this.pass('challenge-failed');
			});
		}

		/**
		 * Handler for swap command.
		 * Player wants to swap their current rack for a different
		 * letters.
		 * @param {Tile[]} tiles list of Tile to swap
		 * @return {Promise} resolving to a {@link Turn}
		 */
		swap(tiles) {
			const swappingPlayer = this.getPlayer();
			swappingPlayer.stopTimer();

			if (this.letterBag.remainingTileCount() < tiles.length)
				// Terminal, no point in translating
				throw Error(`Cannot swap, bag only has ${this.letterBag.remainingTileCount()} tiles`);

			delete this.previousMove;
			swappingPlayer.passes++;

			// Construct a move to record the results of the swap
			const move = new Move();

			// First get some new tiles
			// Scrabble Rule #7: You may use a turn to exchange all,
			// some, or none of the letters. To do this, place your
			// discarded letter(s) facedown. Draw the same number of
			// letters from the pool, then mix your discarded
			// letter(s) into the pool.
			let tile;
			for (tile of tiles)
				move.addReplacement(this.letterBag.getRandomTile());

			// Return discarded tiles to the letter bag
			for (tile of tiles) {
				const removed = swappingPlayer.rack.removeTile(tile);
				if (!removed)
					// Terminal, no point in translating
					throw Error(`Cannot swap, player rack does not contain letter ${tile.letter}`);
				this.letterBag.returnTile(removed);
			}

			// Place new tiles on the rack
			for (tile of move.replacements)
				swappingPlayer.rack.addTile(tile);

			const nextPlayer = this.nextPlayer();
			this.startTurn(nextPlayer);

			return Promise.resolve(
				new Turn(this,
						 {
							 type: 'swap',
							 playerKey: swappingPlayer.key,
							 nextToGoKey: nextPlayer.key,
							 replacements: move.replacements
						 }));
		}

		/**
		 * Handler for 'anotherGame' command
		 * @return {Promise} resolving to the key of the new game
		 */
		anotherGame() {
			if (this.nextGameKey) {
				console.error(`another game already created: old ${this.key} new ${this.nextGameKey}`);
				return Promise.reject("Next game already exists");
			}

			if (this.debug)
				console.debug(`Create game to follow ${this.key}`);
			return new Game(this)
			.create()
			.then(newGame => newGame.onLoad(this._db))
			.then(newGame => {
				this.nextGameKey = newGame.key;
				return this.save()
				.then(() => {
					// Re-order players in random order. Everyone should
					// get an equal chance to start a game, and shouldn't
					// always play in the same order.
					const picked = [];
					this.players.forEach(p => picked.push(p));
					for (let i = picked.length - 1; i > 0; i--) {
						const j = Math.floor(Math.random() * (i + 1));
						const temp = picked[i];
						picked[i] = picked[j];
						picked[j] = temp;
					}
					picked

					// re-order players so they play in score order
					//this.players.slice().sort((a, b) => {
					//	return a.score > b.score
					//             ? -1 : a.score < b.score ? 1 : 0;
					//})

					.forEach(p => newGame.addPlayer(new Player(p)));

					newGame.whosTurnKey = newGame.players[0].key;
					newGame.players[0].secondsToPlay = newGame.secondsPerPlay;
					if (this.debug)
						console.debug(`Created follow-on game ${newGame.key}`);
					return newGame.save()
					.then(() => newGame.playIfReady())
					.then(() => this.notifyPlayers('nextGame', newGame.key))
					.then(() => newGame.key);
				});
			});
		}

		/**
		 * Create the DOM for the player table
		 * @param {Player} thisPlayer the player for whom the DOM is
		 * being generated
		 */
		createPlayerTableDOM(thisPlayer) {
			const $tab = $('<table class="playerTable"></table>');
			this.players.forEach(
				p => $tab.append(p.createScoreDOM(
					thisPlayer, this.state === 'playing')));
			return $tab;
		}
	}

	Game.classes = [ LetterBag, Square, Board, Tile, Rack,
					 Game, Player, Move, Turn ];

	return Game;
});

