var path = require("path");
var fs = require( "fs" );
var npm = require( "npm" );
var child_process = require( "child_process" );

var pluginManagerFactory = function( _, anvil ) {

	var installPath = anvil.fs.buildPath( [ "~/.anvilplugins" ] ),
		pluginInstallPath = anvil.fs.buildPath( [ "~/.anvilplugins/node_modules" ] ),
		dataPath = anvil.fs.buildPath( [ installPath, "plugins.json" ] ),
		builtIn = { list: [
			"anvil.combiner",
			"anvil.concat",
			"anvil.headers",
			"anvil.identify",
			"anvil.output",
			"anvil.plugin",
			"anvil.token",
			"anvil.transform",
			"anvil.workset"
		] };

	var PluginManager = function() {
		_.bindAll( this );
		this.installPath = pluginInstallPath;
		anvil.pluginManager = this;
		anvil.fs.ensurePath( pluginInstallPath, function() {
			if( !anvil.fs.pathExists( dataPath ) ) {
				anvil.fs.write( dataPath, JSON.stringify( builtIn ) );
			}
		} );
	};

	PluginManager.prototype.addPlugin = function( plugin, onComplete ) {
		anvil.fs.read( dataPath, function( json ) {
			var plugins = JSON.parse( json );
			if( ! _.any( plugins.list, function( name ) { return name === plugin; } ) ) {
				plugins.list.push( plugin );
				json = JSON.stringify( plugins, null, 4 );
				anvil.fs.write( dataPath, json, function( err ) {
					onComplete( err );
				} );
			} else {
				onComplete();
			}
		} );
	};

	PluginManager.prototype.checkDependencies = function( dependencies, done ) {
		anvil.log.step( "checking for " + dependencies.length + " build dependencies " );
		var self = this;
		this.getInstalled( pluginInstallPath, function( list ) {
			var installers = _.map( dependencies, function( dependency ) {
				if( !_.contains( list, dependency ) ) {
					return function( done ) {
						self.install( dependency, function( result ) {
							if( !result ) {
								done();
							} else {
								anvil.log.error( "Fatal: Could not install missing build dependency " + dependency );
								anvil.events.raise( "all.stop", -1 );
							}
						} );
					};
				} else {
					return function( done ) { done(); };
				}
			} );
			if( installers.length > 0 ) {
				anvil.scheduler.pipeline( undefined, installers, done );
			} else {
				done();
			}
		} );
	};

	PluginManager.prototype.disable = function( pluginName, done ) {
		this.removePlugin( pluginName, function( succeeded, err ) {
			if( succeeded && !err ) {
				anvil.log.complete( "Plugin '" + pluginName + "' is disabled" );
			} else {
				anvil.log.error( "Disabling plugin '" + pluginName + "' failed" );
			}
		} );
	};

	PluginManager.prototype.enable = function( pluginName, done ) {
		var self = this;
		this.getInstalled( pluginInstallPath, function( list ) {
			if( _.contains( list, pluginName ) ) {
				self.addPlugin( pluginName, function() {
					anvil.log.complete( "Plugin '" + pluginName + "' is enabled" );
					done();
				} );
			} else {
				anvil.log.error( "Can't enable plugin '" + pluginName + "'. It is not installed." );
				done();
			}
		} );
	};

	PluginManager.prototype.getInstalled = function( pluginPath, done ) {
		var self = this,
			list = [];
		
		if( anvil.fs.pathExists( pluginPath ) ) {
			anvil.fs.getFiles( pluginPath, pluginPath, function( files, directories ) {
				_.each( directories, function( directory ) {
					if( directory !== pluginPath ) {
						list.push( directory.replace( pluginPath, "" ).replace( path.sep, "" ) );
					}
				}, [ pluginPath ], 1 );
				done( list );
			} );
		} else {
			done( list );
		}
	};

	PluginManager.prototype.getEnabledPlugins = function( done ) {
		anvil.fs.read( dataPath, function( json, err ) {
			if(! err ) {
				done( JSON.parse( json ).list );
			} else {
				done( [] );
			}
		} );
	};

	PluginManager.prototype.getPlugins = function( done ) {
		var self =this,
			list = [];
		anvil.log.step( "loading plugins" );
		
		this.getEnabledPlugins( function( plugins ) {
			var removals = [];
			_.each( plugins, function( plugin ) {
				var pluginPath = anvil.fs.buildPath( [ pluginInstallPath, plugin ] );
				self.loadPlugin( plugin, pluginPath, list, removals );
			} );
			if( removals.length > 0 ) {
				_.defer( function() {
					anvil.scheduler.pipeline( undefined, removals, function() {
						anvil.events.raise( "all.stop", -1 );
					} );
				} );
			}
			done( list );
		} );
	};

	PluginManager.prototype.getPluginName = function( pluginName ) {
		var pluginPath = path.resolve( pluginName );
		if( anvil.fs.pathExists( pluginPath ) ) {
			return require( path.join( pluginPath, 'package.json' ) ).name;
		}
		return pluginName;
	};

	PluginManager.prototype.getTasks = function( done ) {
		var self = this,
			list = [],
			taskPath = anvil.loadedConfig.tasks ?
						anvil.fs.buildPath( anvil.loadedConfig.tasks ):
						path.resolve( anvil.config.tasks );
		anvil.log.step( "loading tasks from " + taskPath );
		this.getInstalled( taskPath, function( tasks ) {
			_.each( tasks, function( task ) {
				var basePath = anvil.fs.buildPath( [ taskPath, task ] ),
					scriptPath = anvil.fs.buildPath( [ basePath, task + ".js" ] ),
					exists = anvil.fs.pathExists( scriptPath );
				self.loadPlugin( task, exists ? scriptPath : basePath , list, [] );
			} );
			done( list );
		} );
	};

	PluginManager.prototype.install = function( pluginName, done ) {
		var self = this,
			realPluginName = this.getPluginName( pluginName ),
			isPath = anvil.fs.pathExists( pluginName ),
			cwd = process.cwd(),
			reset = function( data ) {
				process.chdir( cwd );
				done( data );
			};
		pluginName = isPath ? path.resolve( pluginName ) : pluginName;
		anvil.log.step( "Installing plugin: " + realPluginName );
		anvil.fs.ensurePath( pluginInstallPath, function() {
			process.chdir( installPath );
			npm.load( npm.config, function( err, npm ) {
				try {
					npm.localPrefix = installPath;
					npm.config.set( "loglevel", "silent" );
					npm.config.set( "global", false );
					npm.commands.install( [ pluginName ], function( err, data ) {
						if( !err ) {
							anvil.log.complete( "Installation of '" + realPluginName + "' completed successfully." );
							self.addPlugin( realPluginName, function() {
								var packagePath = anvil.fs.buildPath( [ pluginInstallPath, realPluginName, "package.json" ] ),
									dependencies = require( packagePath ).requiredPlugins;
								if( dependencies && dependencies.length > 0 ) {
									self.getInstalled( pluginInstallPath, function( installed ) {
										var missing = _.difference( dependencies, installed );
										anvil.scheduler.parallel( missing, self.install, function() { reset(); } );
									} );
								} else {
									reset();
								}
							} );
						} else {
							anvil.log.error( "Installation of '" + realPluginName + "' has failed with error: \n" + err.stack );
							reset( { plugin: realPluginName } );
						}
					} );
					
				} catch ( err ) {
					anvil.log.error( "Installation of '" + realPluginName + "' has failed with error: \n" + err.stack );
					reset( { plugin: realPluginName } );
				}
			} );
		} );
	};

	PluginManager.prototype.list = function( ignore, done ) {
		var self = this;
		anvil.log.complete( "Plugin list: " );
		this.getInstalled( pluginInstallPath, function( plugins ) {
			_.each( plugins, function( plugin ) {
				anvil.log.event( plugin );
			} );
			done();
		} );
	};

	PluginManager.prototype.loadPlugin = function( plugin, pluginPath, list, removals ) {
		var self = this;
		removals = removals || [];
		try {
			var modulePath = path.resolve( pluginPath );
			var instance = require( modulePath )( _, anvil ),
				metadata = { instance: instance, name: plugin };
			if( list ) {
				list.push( metadata );
			}
			anvil.events.raise( "plugin.loaded", instance );
			anvil.log.debug( "loaded plugin " + plugin );
		} catch ( err ) {
			anvil.log.error( "Error loading plugin '" + plugin + "' : " + err.stack );
			removals.push( function( done ) { self.removePlugin( plugin, function() {
					anvil.log.step( "Plugin '" + plugin + "' cannot be loaded and has been disabled");
				} );
			} );
		}
	};

	PluginManager.prototype.removePlugin = function( plugin, onComplete ) {
		this.getEnabledPlugins( function( plugins ) {
			if( _.any( plugins, function( name ) { return name === plugin; } ) ) {
				plugins = _.reject( plugins, function( name ) { return name === plugin; } );
				var json = JSON.stringify( { list: plugins }, null, 4 );
				anvil.fs.write( dataPath, json, function( err ) {
					onComplete( true );
				} );
			} else {
				onComplete( false );
			}
		} );
	};

	PluginManager.prototype.uninstall = function( pluginName, done ) {
		anvil.log.step( "Uninstalling plugin: " + pluginName );
		var self = this,
			cwd = process.cwd(),
			reset = function( data ) {
				process.chdir( cwd );
				done( data );
			};
		npm.load( npm.config, function( err, npm ) {
			try {
				process.chdir( installPath );
				npm.localPrefix = installPath;
				npm.config.set( "loglevel", "silent" );
				npm.config.set( "global", false );
				npm.commands.uninstall( [ pluginName ], function( err, data ) {
					if( !err ) {
						anvil.log.complete( "Uninstallation of '" + pluginName + "' completed successfully." );
						self.removePlugin( pluginName, reset );
					} else {
						anvil.log.error( "Uninstallation of '" + pluginName + "' has failed: " + err );
						reset( { plugin: pluginName } );
					}
				} );
			} catch ( err ) {
				anvil.log.error( "Uninstallation of '" + pluginName + "' has failed: " + err );
				reset( { plugin: pluginName } );
			}
		} );
	};

	return new PluginManager();
};

module.exports = pluginManagerFactory;