
/**
 * Module dependencies.
 */

var express             = require('express'),
    os                  = require('os'),
    fs                  = require('fs'),
    http                = require('http'),
    path                = require('path'),
    extend              = require('extend'),
    hbs                 = require('hbs'),
    logger              = require('morgan'),
    cookieParser        = require('cookie-parser'),
    bodyParser          = require('body-parser'),
    samlp               = require('samlp'),
    config              = require('./config.js'),
    SimpleProfileMapper = require('./simpleProfileMapper.js');

/**
 * Globals
 */

var app    = express();
var server = http.createServer(app);
var blocks = {};

/**
 * Arguments
 */

var argv = require('yargs')
    .usage('Simple IdP\nUsage: $0')
    .example('$0 --acs http://acme.okta.com/auth/saml20/exampleidp --aud https://www.okta.com/saml2/service-provider/spf5aFRRXFGIMAYXQPNV', 
        '\n\nStart IdP web server minting SAML assertions for service provider ACS URL and audience')
    .default({ p: 7000, iss: 'urn:example:idp', disableRequestAcsUrl: false})
    .alias('p', 'port')
    .describe('port', 'Web server listener port')
    .alias('iss', 'issuer')
    .describe('issuer', 'IdP Issuer URI')
    .alias('acs', 'acsUrl')
    .describe('acsUrl', 'SP Assertion Consumer URL')
    .alias('aud', 'audience')
    .describe('audience', 'SAML SP Audience')
    .alias('rs', 'relayState')
    .describe('relayState', 'Default SAML RelayState for AuthnResponse')
    .boolean('disableRequestAcsUrl')
    .alias('static', 'disableRequestAcsUrl')
    .describe('disableRequestAcsUrl', 'Disables ability for AuthnRequest to specify Assertion Consumer URL')
    .demand('aud', 'acs')
    .argv
;

console.log();
console.log('loading configuration...');
console.log();
console.log('Listener Port:\n\t' + argv.port);
console.log('IdP Issuer URI:\n\t' + argv.issuer);
console.log('SP ACS URL:\n\t' + argv.acsUrl);
console.log('SP Audience URI:\n\t' + argv.audience);
console.log('Default RelayState:\n\t' + argv.relayState);
console.log('Allow SP to Specify ACS URLs:\n\t' + !argv.disableRequestAcsUrl);
console.log();

/**
 * IdP Configuration
 */

var idpOptions = {
  issuer:               argv.issuer,
  cert:                 fs.readFileSync(path.join(__dirname, 'server-cert.pem')),
  key:                  fs.readFileSync(path.join(__dirname, 'server-key.pem')),
  audience:             argv.audience,
  recipient:            argv.acsUrl,
  destination:          argv.acsUrl,
  acsUrl:               argv.acsUrl,
  RelayState:           argv.relayState,
  allowRequestAcsUrl:   !argv.disableRequestAcsUrl,
  digestAlgorithm:      'sha1',
  signatureAlgorithm:   'rsa-sha1',
  signResponse:         false,
  lifetimeInSeconds:    3600,
  authnContextClassRef: 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport',
  profileMapper:        SimpleProfileMapper,
  getUserFromRequest:   function(req) { return req.user; },
  getPostURL:           function (audience, authnRequestDom, req, callback) {
                          return callback(null, (req.authnRequest && req.authnRequest.acsUrl) ? 
                            req.authnRequest.acsUrl : 
                            argv.acsUrl);
                        }
}

/**
 * App Environment
 */

app.set('port', process.env.PORT || argv.port);
app.set('views', path.join(__dirname, 'views'));

/**
 * View Engine
 */

app.set('view engine', 'hbs');
app.set('view options', { layout: 'layout' })
app.engine('handlebars', hbs.__express);

// Register Helpers
hbs.registerHelper('extend', function(name, context) {
    var block = blocks[name];
    if (!block) {
        block = blocks[name] = [];
    }

    block.push(context.fn(this));
});

hbs.registerHelper('block', function(name) {
    var val = (blocks[name] || []).join('\n');
    // clear the block
    blocks[name] = [];
    return val;
});


hbs.registerHelper('select', function(selected, options) {
    return options.fn(this).replace(
        new RegExp(' value=\"' + selected + '\"'),
        '$& selected="selected"');
});


hbs.registerHelper('serialize', function(context) {
  return new Buffer(JSON.stringify(context)).toString('base64');
});

/**
 * Middleware
 */

app.use(logger(':date> :method :url - {:referrer} => :status (:response-time ms)'));
app.use(bodyParser.urlencoded({extended: true})) 
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));


/**
 * View Handlers
 */


var showUser = function (req, res, next) {
  res.render('user', {
    user: req.user,
    authnRequest: req.authnRequest,
    idp: req.idp.options
  });
}


/**
 * Routes
 */

app.use(function(req, res, next){
  req.user = config.user;
  req.idp = { options: idpOptions };

  samlp.parseRequest(req, function(err, data) {
    if (data) {
      req.authnRequest = {
        relayState: req.query.RelayState || req.body.RelayState,
        id: data.id,
        issuer: data.issuer,
        destination: data.destination,
        acsUrl: data.assertionConsumerServiceURL,
        forceAuthn: data.forceAuthn
      };
      console.log('Received AuthnRequest => \n', req.authnRequest);
    }
    next();
  });
});


app.get(['/', '/idp'], showUser);

app.post(['/', '/idp'], function(req, res, next) {
  
  var authOptions = extend({}, req.idp.options);

  if (req.body.SAMLRequest) {
    showUser(req, res, next);
  } else {
    // Form POST
    Object.keys(req.body).forEach(function(key) {
      var buffer;
      if (key === '_authnRequest') {
        buffer = new Buffer(req.body[key], 'base64');
        req.authnRequest = JSON.parse(buffer.toString('utf8'));

        // Apply AuthnRequest Params
        authOptions.inReponseTo = req.authnRequest.id;
        if (req.idp.options.allowRequestAcsUrl && req.authnRequest.acsUrl) {
          authOptions.acsUrl = req.authnRequest.acsUrl;
          authOptions.recipient = req.authnRequest.acsUrl;
          authOptions.destination = req.authnRequest.acsUrl;
        }
        if (req.authnRequest.relayState) {
          authOptions.RelayState = req.authnRequest.relayState;
        }
      } else {
        req.user[key] = req.body[key];
      }
    });

    // Keep calm and Single Sign On
    console.log('Sending Assertion with Options => \n', authOptions);
    samlp.auth(authOptions)(req, res);
  }
});

app.get('/metadata', function(req, res, next) {
  samlp.metadata(req.idp.options)(req, res);
});

app.get(['/settings'], function(req, res, next) {
  res.render('settings', {
    idp: req.idp.options
  });
});

app.post(['/settings'], function(req, res, next) {
  Object.keys(req.body).forEach(function(key) {
    switch(req.body[key].toLowerCase()){
      case "true": case "yes": case "1":
        req.idp.options[key] = true;
        break;
      case "false": case "no": case "0":
        req.idp.options[key] = false;
        break;
      default:
        req.idp.options[key] = req.body[key];
        break;
    }

    if (req.body[key].match(/^\d+$/)) {
      req.idp.options[key] = parseInt(req.body[key], '10');
    }
  });

  console.log('Updated IdP Configuration => \n', req.idp.options);
  res.redirect('/');
});

// catch 404 and forward to error handler
app.use(function(req, res, next) {
    var err = new Error('Not Found');
    err.status = 404;
    next(err);
});

// development error handler
app.use(function(err, req, res, next) {
  res.status(err.status || 500);
  res.render('error', {
      message: err.message,
      error: err
  });
});

/**
 * App Start
 */

console.log('starting server...');
server.listen(app.get('port'), function() {
  var address  = server.address(),
      hostname = os.hostname();
      baseUrl  = address.address === '0.0.0.0' ? 
        'http://' + hostname + ':' + address.port :
        'http://localhost:' + address.port
  
  console.log('listening on port: ' + app.get('port'));
  console.log();
  console.log('urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST');
  console.log('\t=> ' + baseUrl + '/idp')
  console.log('urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect');
  console.log('\t=> ' + baseUrl + '/idp')
  console.log();
});