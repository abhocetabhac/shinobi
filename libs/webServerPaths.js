var express = require('express');
var fs = require('fs');
var bodyParser = require('body-parser');
var os = require('os');
var moment = require('moment');
var request = require('request');
var execSync = require('child_process').execSync;
var exec = require('child_process').exec;
var spawn = require('child_process').spawn;
var httpProxy = require('http-proxy');
var proxy = httpProxy.createProxyServer({})
var ejs = require('ejs');
var fileupload = require("express-fileupload");
module.exports = function(s,config,lang,app,io){
    const {
        ptzControl,
        setPresetForCurrentPosition
    } = require('./control/ptz.js')(s,config,lang,app,io)
    const {
        triggerEvent,
    } = require('./events/utils.js')(s,config,lang)
    const {
        basicAuth,
        superLogin,
        createTwoFactorAuth,
        twoFactorVerification,
        ldapLogin,
    } = require('./auth/utils.js')(s,config,lang)
    const {
        spawnSubstreamProcess,
        destroySubstreamProcess,
    } = require('./monitor/utils.js')(s,config,lang)
    s.renderPage = function(req,res,paths,passables,callback){
        passables.window = {}
        passables.data = req.params
        passables.originalURL = s.getOriginalUrl(req)
        passables.baseUrl = req.protocol+'://'+req.hostname
        passables.config = s.getConfigWithBranding(req.hostname)
        res.render(paths,passables,callback)
    }
    //child node proxy check
    //params = parameters
    //cb = callback
    //res = response, only needed for express (http server)
    //request = request, only needed for express (http server)
    s.checkChildProxy = function(params,cb,res,req) {
        if(s.group[params.ke] && s.group[params.ke].activeMonitors && s.group[params.ke].activeMonitors[params.id] && s.group[params.ke].activeMonitors[params.id].childNode){
            var url = 'http://' + s.group[params.ke].activeMonitors[params.id].childNode// + req.originalUrl
            proxy.web(req, res, { target: url })
        }else{
            cb()
        }
    }
    s.closeJsonResponse = function(res,endData){
        res.setHeader('Content-Type', 'application/json')
        res.end(s.prettyPrint(endData))
    }
    //get post data
    s.getPostData = function(req,target,parseJSON){
        if(!target)target = 'data'
        if(!parseJSON)parseJSON = true
        var postData = false
        if(req.query && req.query[target]){
            postData = req.query[target]
        }else{
            postData = req.body[target]
        }
        if(parseJSON === true){
            postData = s.parseJSON(postData)
        }
        return postData
    }
    //get client ip address
    s.getClientIp = function(req){
        return req.headers['cf-connecting-ip']||req.headers["CF-Connecting-IP"]||req.headers["'x-forwarded-for"]||req.connection.remoteAddress;
    }
    ////Pages
    app.enable('trust proxy');
    if(config.webPaths.home !== '/'){
        app.use('/libs',express.static(s.mainDirectory + '/web/libs'))
    }
    [
        [config.webPaths.home,'libs','/web/libs'],
        [config.webPaths.admin,'libs','/web/libs'],
        [config.webPaths.super,'libs','/web/libs'],
        [config.webPaths.home,'assets','/web/assets'],
        [config.webPaths.admin,'assets','/web/assets'],
        [config.webPaths.super,'assets','/web/assets'],
    ].forEach((piece) => {
        app.use(s.checkCorrectPathEnding(piece[0])+piece[1],express.static(s.mainDirectory + piece[2]))
    })
    app.use(bodyParser.json());
    app.use(bodyParser.urlencoded({extended: true}));
    app.use(function (req,res,next){
        res.header("Access-Control-Allow-Origin",'*');
        next()
    })
    app.set('views', s.mainDirectory + '/web');
    app.set('view engine','ejs');
    //add template handler
    if(config.renderPaths.handler!==undefined){require(s.mainDirectory+'/web/'+config.renderPaths.handler+'.js').addHandlers(s,app,io,config)}

    /**
    * API : Logout
    */
    app.get(config.webPaths.apiPrefix+':auth/logout/:ke/:id', function (req,res){
        if(s.group[req.params.ke] && s.group[req.params.ke].users[req.params.auth] && s.group[req.params.ke].users[req.params.auth].details){
            delete(s.api[req.params.auth]);
            delete(s.group[req.params.ke].users[req.params.auth]);
            s.knexQuery({
                action: "update",
                table: "Users",
                update: {
                    auth: '',
                },
                where: [
                    ['auth','=',req.params.auth],
                    ['ke','=',req.params.ke],
                    ['uid','=',req.params.id],
                ]
            })
            res.end(s.prettyPrint({ok:true,msg:'You have been logged out, session key is now inactive.'}))
        }else{
            res.end(s.prettyPrint({ok:false,msg:'This group key does not exist or this user is not logged in.'}))
        }
    });
    /**
    * Page : Login Screen
    */
    app.get(config.webPaths.home, function (req,res){
        s.renderPage(req,res,config.renderPaths.index,{lang:lang,config: s.getConfigWithBranding(req.hostname),screen:'dashboard'})
    });
    /**
    * Page : Administrator Login Screen
    */
    app.get(config.webPaths.admin, function (req,res){
        s.renderPage(req,res,config.renderPaths.index,{lang:lang,config: s.getConfigWithBranding(req.hostname),screen:'admin'})
    });
    /**
    * Page : Superuser Login Screen
    */
    app.get(config.webPaths.super, function (req,res){
        s.renderPage(req,res,config.renderPaths.index,{
            lang: lang,
            config: s.getConfigWithBranding(req.hostname),
            screen: 'super'
        })
    });
    /**
    * API : Get User Info
    */
    app.get(config.webPaths.apiPrefix+':auth/userInfo/:ke',function (req,res){
        var response = {ok:false};
        res.setHeader('Content-Type', 'application/json');
        s.auth(req.params,function(user){
            response.ok = true
            response.user = user
            res.end(s.prettyPrint(response));
        },res,req);
    })
    //login function
    s.deleteFactorAuth=function(r){
        delete(s.factorAuth[r.ke][r.uid])
        if(Object.keys(s.factorAuth[r.ke]).length===0){
            delete(s.factorAuth[r.ke])
        }
    }
    /**
    * API : Login handler. Dashboard, Streamer, Dashcam Administrator, Superuser
    */
    app.post([
        config.webPaths.home,
        config.webPaths.admin,
        config.webPaths.super,
        s.checkCorrectPathEnding(config.webPaths.home)+':screen',
        s.checkCorrectPathEnding(config.webPaths.admin)+':screen',
        s.checkCorrectPathEnding(config.webPaths.super)+':screen',
    ],async function (req,res){
        var response = {ok: false};
        req.ip = s.getClientIp(req)
        const screenChooser = function(screen){
            var search = function(screen){
                if(req.url.indexOf(screen) > -1){
                    return true
                }
                return false
            }
            switch(true){
                // case search(config.webPaths.admin):
                //     return 'admin'
                // break;
                case search(config.webPaths.super):
                    return 'super'
                break;
                default:
                    return 'dashboard'
                break;
            }
        }
        // brute check
        if(s.failedLoginAttempts[req.body.mail] && s.failedLoginAttempts[req.body.mail].failCount >= 5){
            if(req.query.json=='true'){
                res.end(s.prettyPrint({ok:false}))
            }else{
                s.renderPage(req,res,config.renderPaths.index,{
                    failedLogin: true,
                    message: lang.failedLoginText1,
                    lang: s.copySystemDefaultLanguage(),
                    config: s.getConfigWithBranding(req.hostname),
                    screen: screenChooser(req.params.screen)
                })
            }
            return false
        }
        //
        const renderPage = function(focus,data){
            if(s.failedLoginAttempts[req.body.mail]){
                clearTimeout(s.failedLoginAttempts[req.body.mail].timeout)
                delete(s.failedLoginAttempts[req.body.mail])
            }
            if(req.query.json=='true'){
                delete(data.config)
                data.ok = true;
                res.setHeader('Content-Type', 'application/json');
                res.end(s.prettyPrint(data))
            }else{
                data.screen=req.params.screen
                s.renderPage(req,res,focus,data)
            }
        }
        const failedAuthentication = function(board,failIdentifier,failMessage){
            // brute protector
            if(!failIdentifier){
                s.renderPage(req,res,config.renderPaths.index,{
                    failedLogin: true,
                    message: failMessage || lang.failedLoginText2,
                    lang: s.copySystemDefaultLanguage(),
                    config: s.getConfigWithBranding(req.hostname),
                    screen: screenChooser(req.params.screen)
                })
                return
            }
            if(!s.failedLoginAttempts[failIdentifier]){
                s.failedLoginAttempts[failIdentifier] = {
                    failCount : 0,
                    ips : {}
                }
            }
            ++s.failedLoginAttempts[failIdentifier].failCount
            if(!s.failedLoginAttempts[failIdentifier].ips[req.ip]){
                s.failedLoginAttempts[failIdentifier].ips[req.ip] = 0
            }
            ++s.failedLoginAttempts[failIdentifier].ips[req.ip]
            clearTimeout(s.failedLoginAttempts[failIdentifier].timeout)
            s.failedLoginAttempts[failIdentifier].timeout = setTimeout(function(){
                delete(s.failedLoginAttempts[failIdentifier])
            },1000 * 60 * 15)
            // check if JSON
            if(req.query.json === 'true'){
                res.setHeader('Content-Type', 'application/json')
                res.end(s.prettyPrint({ok:false}))
            }else{
                s.renderPage(req,res,config.renderPaths.index,{
                    failedLogin: true,
                    message: failMessage || lang.failedLoginText2,
                    lang: s.copySystemDefaultLanguage(),
                    config: s.getConfigWithBranding(req.hostname),
                    screen: screenChooser(req.params.screen)
                })
            }
            var logTo = {
                ke: '$',
                mid: '$USER'
            }
            var logData = {
                type: lang['Authentication Failed'],
                msg: {
                    for: board,
                    mail: failIdentifier,
                    ip: req.ip
                }
            }
            if(board === 'super'){
                s.userLog(logTo,logData)
            }else{
                s.knexQuery({
                    action: "select",
                    columns: "ke,uid,details",
                    table: "Users",
                    where: [
                        ['mail','=',failIdentifier],
                    ]
                },(err,r) => {
                    if(r && r[0]){
                        r = r[0]
                        r.details = JSON.parse(r.details)
                        r.lang = s.getLanguageFile(r.details.lang)
                        logData.id = r.uid
                        logData.type = r.lang['Authentication Failed']
                        logTo.ke = r.ke
                    }
                    s.userLog(logTo,logData)
                })
            }
        }
        function checkRoute(pageTarget,userInfo){
            if(!userInfo.lang){
                userInfo.lang = s.getLanguageFile(userInfo.details.lang)
            }
            switch(pageTarget){
                case'cam':
                    renderPage(config.renderPaths.dashcam,{
                        // config: s.getConfigWithBranding(req.hostname),
                        $user: userInfo,
                        lang: userInfo.lang,
                        define: s.getDefinitonFile(userInfo.details.lang),
                        customAutoLoad: s.customAutoLoadTree
                    })
                break;
                case'streamer':
                    renderPage(config.renderPaths.streamer,{
                        // config: s.getConfigWithBranding(req.hostname),
                        $user: userInfo,
                        lang: userInfo.lang,
                        define: s.getDefinitonFile(userInfo.details.lang),
                        customAutoLoad: s.customAutoLoadTree
                    })
                break;
                case'admin':
                default:
                    var chosenRender = 'home'
                    if(userInfo.details.sub && userInfo.details.landing_page && userInfo.details.landing_page !== '' && config.renderPaths[userInfo.details.landing_page]){
                        chosenRender = userInfo.details.landing_page
                    }
                    renderPage(config.renderPaths[chosenRender],{
                        $user: userInfo,
                        config: s.getConfigWithBranding(req.hostname),
                        lang: userInfo.lang,
                        define: s.getDefinitonFile(userInfo.details.lang),
                        addStorage: s.dir.addStorage,
                        fs: fs,
                        __dirname: s.mainDirectory,
                        customAutoLoad: s.customAutoLoadTree
                    })
                break;
            }
            s.userLog({
                ke: userInfo.ke,
                mid: '$USER'
            },{
                type: userInfo.lang['New Authentication Token'],
                msg: {
                    for: pageTarget,
                    mail: userInfo.mail,
                    id: userInfo.uid,
                    ip: req.ip
                }
            })
        }
        if(req.body.alternateLogin && s.alternateLogins[req.body.alternateLogin]){
            const alternateLogin = s.alternateLogins[req.body.alternateLogin]
            const alternateLoginResponse = await alternateLogin(req.body)
            if(alternateLoginResponse.ok && alternateLoginResponse.user){
                const user = alternateLoginResponse.user
                const sessionKey = s.md5(s.gid())
                user.auth = sessionKey
                s.knexQuery({
                    action: "update",
                    table: "Users",
                    update: {
                        auth: sessionKey
                    },
                    where: [
                        ['ke','=',user.ke],
                        ['uid','=',user.uid],
                    ]
                })
                checkRoute(req.body.function,{
                    ok: true,
                    auth_token: user.auth,
                    ke: user.ke,
                    uid: user.uid,
                    mail: user.mail,
                    details: user.details
                })
            }else{
                return failedAuthentication(req.body.function,req.body.mail,alternateLoginResponse.msg)
            }
        }else if(req.body.mail && req.body.pass){
            async function regularLogin(){
                const basicAuthResponse = await basicAuth(req.body.mail,req.body.pass)
                if(basicAuthResponse.user){
                    const user = basicAuthResponse.user;
                    const sessionKey = s.md5(s.gid())
                    user.auth = sessionKey
                    user.lang = s.getLanguageFile(user.details.lang)
                    s.knexQuery({
                        action: "update",
                        table: "Users",
                        update: {
                            auth: user.auth
                        },
                        where: [
                            ['ke','=',user.ke],
                            ['uid','=',user.uid],
                        ]
                    })
                    if(user.details.sub){
                        const adminUserCheckResponse = await s.knexQueryPromise({
                            action: "select",
                            columns: "details",
                            table: "Users",
                            where: [
                                ['ke','=',user.ke],
                                ['details','NOT LIKE','%"sub"%'],
                            ],
                            limit: 1,
                        })
                        if(adminUserCheckResponse.rows && adminUserCheckResponse.rows[0]){
                            const adminUser = adminUserCheckResponse.rows[0];
                            const adminUserDetails = s.parseJSON(adminUser.details);
                            user.details.mon_groups = adminUserDetails.mon_groups;
                        }else{
                            return failedAuthentication(req.body.function,req.body.mail)
                        }
                    }
                    if(user.details.factorAuth === "1"){
                        const factorAuthCreationResponse = createTwoFactorAuth(
                            user,
                            req.body.machineID || s.md5(s.gid()),
                            req.body.function
                        );
                        if(!factorAuthCreationResponse.goToDashboard){
                            renderPage(config.renderPaths.factorAuth,{
                                $user:{
                                    ke: user.ke,
                                    uid: user.uid,
                                    mail: user.mail
                                },
                                lang: user.lang
                            })
                            return;
                        }
                    }

                    checkRoute(req.body.function,{
                        ok: true,
                        auth_token: user.auth,
                        ke: user.ke,
                        uid: user.uid,
                        mail: user.mail,
                        details: user.details
                    })
                }else{
                    failedAuthentication(req.body.function,req.body.mail)
                }
            }
            if(req.body.function === 'super'){
                const superLoginResponse = await superLogin(req.body.mail,req.body.pass);
                if(superLoginResponse.ok){
                    renderPage(config.renderPaths.super,{
                        config: config,
                        lang: lang,
                        $user: superLoginResponse.user,
                        customAutoLoad: s.customAutoLoadTree,
                        currentVersion: s.currentVersion,
                    })
                }else{
                    failedAuthentication(req.body.function,req.body.mail)
                }
            }else{
                regularLogin()
            }
        }else if(
            req.body.machineID &&
            req.body.factorAuthKey &&
            s.factorAuth[req.body.ke] &&
            s.factorAuth[req.body.ke][req.body.id]
        ){
            const factorAuthObject = s.factorAuth[req.body.ke][req.body.id]
            const twoFactorVerificationResponse = twoFactorVerification({
                ke: req.body.ke,
                id: req.body.id,
                machineID: req.body.machineID,
                factorAuthKey: req.body.factorAuthKey,
            })
            if(twoFactorVerificationResponse.ok){
                checkRoute(twoFactorVerificationResponse.pageTarget,twoFactorVerificationResponse.info)
            }else{
                failedAuthentication(lang['2-Factor Authentication'],factorAuthObject.info.mail)
            }
        }else{
            failedAuthentication(lang['2-Factor Authentication'],req.body.mail)
        }
    })
    /**
    * API : Brute Protection Lock Reset by API
    */
    app.get([config.webPaths.apiPrefix+':auth/resetBruteProtection/:ke'], function (req,res){
        s.auth(req.params,function(user){
            if(s.failedLoginAttempts[user.mail]){
                clearTimeout(s.failedLoginAttempts[user.mail].timeout)
                delete(s.failedLoginAttempts[user.mail])
            }
            res.end(s.prettyPrint({ok:true}))
        })
    })
    // /**
    // * Page : Montage - stand alone squished view with gridstackjs
    // */
    // app.get([
    //     config.webPaths.apiPrefix+':auth/grid/:ke',
    //     config.webPaths.apiPrefix+':auth/grid/:ke/:group',
    //     config.webPaths.apiPrefix+':auth/cycle/:ke',
    //     config.webPaths.apiPrefix+':auth/cycle/:ke/:group'
    // ], function(req,res) {
    //     s.auth(req.params,function(user){
    //         if(user.permissions.get_monitors==="0"){
    //             res.end(user.lang['Not Permitted'])
    //             return
    //         }
    //
    //         req.params.protocol=req.protocol;
    //         req.sql='SELECT * FROM Monitors WHERE mode!=? AND mode!=? AND ke=?';req.ar=['stop','idle',req.params.ke];
    //         if(!req.params.id){
    //             if(user.details.sub&&user.details.monitors&&user.details.allmonitors!=='1'){
    //                 try{user.details.monitors=JSON.parse(user.details.monitors);}catch(er){}
    //                 req.or=[];
    //                 user.details.monitors.forEach(function(v,n){
    //                     req.or.push('mid=?');req.ar.push(v)
    //                 })
    //                 req.sql+=' AND ('+req.or.join(' OR ')+')'
    //             }
    //         }else{
    //             if(!user.details.sub||user.details.allmonitors!=='0'||user.details.monitors.indexOf(req.params.id)>-1){
    //                 req.sql+=' and mid=?';req.ar.push(req.params.id)
    //             }else{
    //                 res.end(user.lang['There are no monitors that you can view with this account.']);
    //                 return;
    //             }
    //         }
    //         s.sqlQuery(req.sql,req.ar,function(err,r){
    //             if(req.params.group){
    //                 var filteredByGroupCheck = {};
    //                 var filteredByGroup = [];
    //                 r.forEach(function(v,n){
    //                     var details = JSON.parse(r[n].details);
    //                     try{
    //                         req.params.group.split('|').forEach(function(group){
    //                             var groups = JSON.parse(details.groups);
    //                             if(groups.indexOf(group) > -1 && !filteredByGroupCheck[v.mid]){
    //                                 filteredByGroupCheck[v.mid] = true;
    //                                 filteredByGroup.push(v)
    //                             }
    //                         })
    //                     }catch(err){
    //
    //                     }
    //                 })
    //                 r = filteredByGroup;
    //             }
    //             r.forEach(function(v,n){
    //                 if(s.group[v.ke]&&s.group[v.ke].activeMonitors[v.mid]&&s.group[v.ke].activeMonitors[v.mid].watch){
    //                     r[n].currentlyWatching=Object.keys(s.group[v.ke].activeMonitors[v.mid].watch).length
    //                 }
    //                 r[n].subStream={}
    //                 var details = JSON.parse(r[n].details)
    //                 if(details.snap==='1'){
    //                     r[n].subStream.jpeg = '/'+req.params.auth+'/jpeg/'+v.ke+'/'+v.mid+'/s.jpg'
    //                 }
    //                 if(details.stream_channels&&details.stream_channels!==''){
    //                     try{
    //                         details.stream_channels=JSON.parse(details.stream_channels)
    //                         r[n].channels=[]
    //                         details.stream_channels.forEach(function(b,m){
    //                             var streamURL
    //                             switch(b.stream_type){
    //                                 case'mjpeg':
    //                                     streamURL='/'+req.params.auth+'/mjpeg/'+v.ke+'/'+v.mid+'/'+m
    //                                 break;
    //                                 case'hls':
    //                                     streamURL='/'+req.params.auth+'/hls/'+v.ke+'/'+v.mid+'/'+m+'/s.m3u8'
    //                                 break;
    //                                 case'h264':
    //                                     streamURL='/'+req.params.auth+'/h264/'+v.ke+'/'+v.mid+'/'+m
    //                                 break;
    //                                 case'flv':
    //                                     streamURL='/'+req.params.auth+'/flv/'+v.ke+'/'+v.mid+'/'+m+'/s.flv'
    //                                 break;
    //                                 case'mp4':
    //                                     streamURL='/'+req.params.auth+'/mp4/'+v.ke+'/'+v.mid+'/'+m+'/s.mp4'
    //                                 break;
    //                             }
    //                             r[n].channels.push(streamURL)
    //                         })
    //                     }catch(err){
    //                         s.userLog(req.params,{type:'Broken Monitor Object',msg:'Stream Channels Field is damaged. Skipping.'})
    //                     }
    //                 }
    //             })
    //             var page = config.renderPaths.grid
    //             if(req.path.indexOf('/cycle/') > -1){
    //                 page = config.renderPaths.cycle
    //             }
    //             s.renderPage(req,res,page,{
    //                 data:Object.assign(req.params,req.query),
    //                 baseUrl:req.protocol+'://'+req.hostname,
    //                 config: s.getConfigWithBranding(req.hostname),
    //                 lang:user.lang,
    //                 $user:user,
    //                 monitors:r,
    //                 query:req.query
    //             });
    //         })
    //     },res,req)
    // });
    /**
    * API : Get TV Channels (Monitor Streams) json
     */
    app.get([config.webPaths.apiPrefix+':auth/tvChannels/:ke',config.webPaths.apiPrefix+':auth/tvChannels/:ke/:id','/get.php'], function (req,res){
        var response = {ok:false};
        if(req.query.username&&req.query.password){
            req.params.username = req.query.username
            req.params.password = req.query.password
        }
        var output = ['h264','hls','mp4']
        if(
            req.query.output &&
            req.query.output !== ''
        ){
            output = req.query.output.split(',')
            output.forEach(function(type,n){
                if(type === 'ts'){
                    output[n] = 'h264'
                    if(output.indexOf('hls') === -1){
                        output.push('hls')
                    }
                }
            })
        }
        const isM3u8 = req.query.type === 'm3u8' || req.query.type === 'm3u_plus'
        s.auth(req.params,function(user){
            const groupKey = req.params.ke
            const monitorId = req.params.id
            const monitorRestrictions = s.getMonitorRestrictions(user.details,monitorId)
            if(user.details.sub && user.details.allmonitors === '0' && (user.permissions.get_monitors === "0" || monitorRestrictions.length === 0)){
                s.closeJsonResponse(res,[]);
                return
            }
            s.knexQuery({
                action: "select",
                columns: "*",
                table: "Monitors",
                where: [
                    ['ke','=',groupKey],
                    ['mode','!=','stop'],
                    monitorRestrictions
                ]
            },(err,r) => {
                var tvChannelMonitors = [];
                r.forEach(function(v,n){
                    var buildStreamURL = function(channelRow,type,channelNumber){
                        var streamURL
            			if(req.query.streamtype && req.query.streamtype != type){
            				return
            			}
                        if(channelNumber){channelNumber = '/' + channelNumber}else{channelNumber = ''}
                        switch(type){
                            case'mjpeg':
                                streamURL='/'+req.params.auth+'/mjpeg/'+v.ke+'/'+v.mid+channelNumber
                            break;
                            case'hls':
                                streamURL='/'+req.params.auth+'/hls/'+v.ke+'/'+v.mid+channelNumber+'/s.m3u8'
                            break;
                            case'h264':
                                streamURL='/'+req.params.auth+'/h264/'+v.ke+'/'+v.mid+channelNumber
                            break;
                            case'flv':
                                streamURL='/'+req.params.auth+'/flv/'+v.ke+'/'+v.mid+channelNumber+'/s.flv'
                            break;
                            case'mp4':
                                streamURL='/'+req.params.auth+'/mp4/'+v.ke+'/'+v.mid+channelNumber+'/s.ts'
                            break;
                        }
                        if(streamURL){
                            if(!channelRow.streamsSortedByType[type]){
                                channelRow.streamsSortedByType[type]=[]
                            }
                            channelRow.streamsSortedByType[type].push(streamURL)
                            channelRow.streams.push(streamURL)
                        }
                        return streamURL
                    }
                    var details = JSON.parse(r[n].details);
                    if(!details.tv_channel_id||details.tv_channel_id==='')details.tv_channel_id = 'temp_'+s.gid(5)
                    var channelRow = {
                        ke:v.ke,
                        mid:v.mid,
                        type:v.type,
                        groupTitle:details.tv_channel_group_title,
                        channel:details.tv_channel_id,
                    };
                    if(details.snap==='1'){
                        channelRow.snapshot = '/'+req.params.auth+'/jpeg/'+v.ke+'/'+v.mid+'/s.jpg'
                    }
                    channelRow.streams=[]
                    channelRow.streamsSortedByType={}
                    buildStreamURL(channelRow,details.stream_type)
                    if(details.stream_channels&&details.stream_channels!==''){
                        details.stream_channels=JSON.parse(details.stream_channels)
                        details.stream_channels.forEach(function(b,m){
                            buildStreamURL(channelRow,b.stream_type,m.toString())
                        })
                    }
                    if(details.tv_channel==='1'){
                        tvChannelMonitors.push(channelRow)
                    }
                })
                if(isM3u8){
                    var m3u8 = '#EXTM3U'+'\n'
                    tvChannelMonitors.forEach(function(channelRow,n){
                      output.forEach(function(type){
                        if(channelRow.streamsSortedByType[type]){
                            if(req.query.type === 'm3u_plus'){
                                m3u8 +='#EXTINF-1 tvg-id="'+channelRow.mid+'" tvg-name="'+channelRow.channel+'" tvg-logo="'+req.protocol+'://'+req.headers.host+channelRow.snapshot+'" group-title="'+channelRow.groupTitle+'",'+channelRow.channel+'\n'
                            }else{
                                m3u8 +='#EXTINF:-1,'+channelRow.channel+' ('+type.toUpperCase()+') \n'
                            }
                            m3u8 += req.protocol+'://'+req.headers.host+channelRow.streamsSortedByType[type][0]+'\n'
                        }
                      })
                    })
                    res.end(m3u8)
                }else{
                    if(tvChannelMonitors.length === 1)tvChannelMonitors=tvChannelMonitors[0];
                    s.closeJsonResponse(res,tvChannelMonitors)
                }
            })
        },res,req);
    });
    /**
    * API : Get Monitors
     */
    app.get([config.webPaths.apiPrefix+':auth/monitor/:ke',config.webPaths.apiPrefix+':auth/monitor/:ke/:id'], function (req,res){
        var response = {ok:false};
        res.setHeader('Content-Type', 'application/json');
        s.auth(req.params,(user) => {
            const groupKey = req.params.ke
            const monitorId = req.params.id
            const monitorRestrictions = s.getMonitorRestrictions(user.details,monitorId)
            if(user.details.sub && user.details.allmonitors === '0' && (user.permissions.get_monitors === "0" || monitorRestrictions.length === 0)){
                s.closeJsonResponse(res,[]);
                return
            }
            s.knexQuery({
                action: "select",
                columns: "*",
                table: "Monitors",
                where: [
                    ['ke','=',groupKey],
                    monitorRestrictions
                ]
            },(err,r) => {
                r.forEach(function(v,n){
                    if(s.group[v.ke] && s.group[v.ke].activeMonitors[v.mid]){
                        const activeMonitor = s.group[v.ke].activeMonitors[v.mid]
                        r[n].currentlyWatching = Object.keys(activeMonitor.watch).length
                        r[n].currentCpuUsage = activeMonitor.currentCpuUsage
                        r[n].status = activeMonitor.monitorStatus
                        r[n].code = activeMonitor.monitorStatusCode
                    }
                    var buildStreamURL = function(type,channelNumber){
                        var streamURL
                        if(channelNumber){channelNumber = '/'+channelNumber}else{channelNumber=''}
                        switch(type){
                            case'mjpeg':
                                streamURL='/'+req.params.auth+'/mjpeg/'+v.ke+'/'+v.mid+channelNumber
                            break;
                            case'hls':
                                streamURL='/'+req.params.auth+'/hls/'+v.ke+'/'+v.mid+channelNumber+'/s.m3u8'
                            break;
                            case'h264':
                                streamURL='/'+req.params.auth+'/h264/'+v.ke+'/'+v.mid+channelNumber
                            break;
                            case'flv':
                                streamURL='/'+req.params.auth+'/flv/'+v.ke+'/'+v.mid+channelNumber+'/s.flv'
                            break;
                            case'mp4':
                                streamURL='/'+req.params.auth+'/mp4/'+v.ke+'/'+v.mid+channelNumber+'/s.mp4'
                            break;
                        }
                        if(streamURL){
                            if(!r[n].streamsSortedByType[type]){
                                r[n].streamsSortedByType[type]=[]
                            }
                            r[n].streamsSortedByType[type].push(streamURL)
                            r[n].streams.push(streamURL)
                        }
                        return streamURL
                    }
                    var details = JSON.parse(r[n].details);
                    if(!details.tv_channel_id||details.tv_channel_id==='')details.tv_channel_id = 'temp_'+s.gid(5)
                    if(details.snap==='1'){
                        r[n].snapshot = '/'+req.params.auth+'/jpeg/'+v.ke+'/'+v.mid+'/s.jpg'
                    }
                    r[n].streams=[]
                    r[n].streamsSortedByType={}
                    buildStreamURL(details.stream_type)
                    if(details.stream_channels&&details.stream_channels!==''){
                        details.stream_channels=s.parseJSON(details.stream_channels)
                        details.stream_channels.forEach(function(b,m){
                            buildStreamURL(b.stream_type,m.toString())
                        })
                    }
                })
                s.closeJsonResponse(res,r);
            })
        },res,req);
    });
    /**
    * API : Toggle Substream Process on and off
     */
    app.get(config.webPaths.apiPrefix+':auth/toggleSubstream/:ke/:id', function (req,res){
        const response = {ok: false};
        s.auth(req.params,async (user) => {
            const groupKey = req.params.ke
            const monitorId = req.params.id
            if(
                user.permissions.control_monitors === "0" ||
                user.details.sub &&
                user.details.allmonitors !== '1' &&
                user.details.monitor_edit.indexOf(monitorId) === -1
            ){
                response.msg = user.lang['Not Permitted']
            }else{
                const monitorConfig = s.group[groupKey].rawMonitorConfigurations[monitorId]
                const activeMonitor = s.group[groupKey].activeMonitors[monitorId]
                if(!activeMonitor.subStreamProcess){
                    response.ok = true
                    spawnSubstreamProcess(monitorConfig)
                }else{
                    await destroySubstreamProcess(activeMonitor)
                }
            }
            s.closeJsonResponse(res,response);
        },res,req);
    });
    /**
    * API : Merge Recorded Videos into one file
     */
     app.get(config.webPaths.apiPrefix+':auth/videosMerge/:ke', function (req,res){
         var failed = function(resp){
             res.setHeader('Content-Type', 'application/json');
             res.end(s.prettyPrint(resp))
         }
         if(req.query.videos && req.query.videos !== ''){
             s.auth(req.params,function(user){
                 var videosSelected = JSON.parse(req.query.videos)
                 const whereQuery = []
                 var didOne = false
                 videosSelected.forEach(function(video){
                     var time = s.nameToTime(video.filename)
                     if(req.query.isUTC === 'true'){
                         time = s.utcToLocal(time)
                     }
                     if(didOne){
                         whereQuery.push(['or','ke','=',req.params.ke])
                     }else{
                         didOne = true
                         whereQuery.push(['ke','=',req.params.ke])
                     }
                     whereQuery.push(
                         ['mid','=',video.mid],
                         ['time','=',time],
                     )

                 })
                 s.knexQuery({
                     action: "select",
                     columns: "*",
                     table: "Videos",
                     where: whereQuery
                 },(err,r) => {
                     var resp = {ok: false}
                     if(r && r[0]){
                         s.mergeRecordedVideos(r,req.params.ke,function(fullPath,filename){
                             res.setHeader('Content-Disposition', 'attachment; filename="'+filename+'"')
                             var file = fs.createReadStream(fullPath)
                             file.on('close',function(){
                                 setTimeout(function(){
                                     s.file('delete',fullPath)
                                 },1000 * 60 * 3)
                                 res.end()
                             })
                             file.pipe(res)
                         })
                     }else{
                         failed({ok:false,msg:'No Videos Found'})
                     }
                 })
             },res,req);
         }else{
             failed({ok:false,msg:'"videos" query variable is missing from request.'})
         }
    })
    /**
    * API : Get Videos
     */
    app.get([
        config.webPaths.apiPrefix+':auth/videos/:ke',
        config.webPaths.apiPrefix+':auth/videos/:ke/:id',
        config.webPaths.apiPrefix+':auth/cloudVideos/:ke',
        config.webPaths.apiPrefix+':auth/cloudVideos/:ke/:id'
    ], function (req,res){
        res.setHeader('Content-Type', 'application/json');
        s.auth(req.params,function(user){
            const userDetails = user.details
            const monitorId = req.params.id
            const groupKey = req.params.ke
            const hasRestrictions = userDetails.sub && userDetails.allmonitors !== '1';
            var origURL = req.originalUrl.split('/')
            var videoParam = origURL[origURL.indexOf(req.params.auth) + 1]
            var videoSet = 'Videos'
            switch(videoParam){
                case'cloudVideos':
                    videoSet = 'Cloud Videos'
                break;
            }
            s.sqlQueryBetweenTimesWithPermissions({
                table: videoSet,
                user: user,
                noCount: true,
                groupKey: req.params.ke,
                monitorId: req.params.id,
                startTime: req.query.start,
                endTime: req.query.end,
                startTimeOperator: req.query.startOperator,
                endTimeOperator: req.query.endOperator,
                limit: req.query.limit,
                archived: req.query.archived,
                endIsStartTo: !!req.query.endIsStartTo,
                parseRowDetails: false,
                rowName: 'videos',
                preliminaryValidationFailed: (
                    user.permissions.watch_videos === "0" ||
                    hasRestrictions &&
                    (!userDetails.video_view || userDetails.video_view.indexOf(monitorId)===-1)
                )
            },(response) => {
                if(response && response.videos){
                    s.buildVideoLinks(response.videos,{
                        auth : req.params.auth,
                        videoParam : videoParam,
                        hideRemote : config.hideCloudSaveUrls,
                    })
                }
                res.end(s.prettyPrint(response))
            })
        },res,req);
    });
    /**
    * API : Get Events
     */
    app.get([
		config.webPaths.apiPrefix+':auth/events/:ke',
		config.webPaths.apiPrefix+':auth/events/:ke/:id'
	], function (req,res){
        res.setHeader('Content-Type', 'application/json');
        s.auth(req.params,function(user){
            const userDetails = user.details
            const monitorId = req.params.id
            const groupKey = req.params.ke
            const hasRestrictions = userDetails.sub && userDetails.allmonitors !== '1';
            s.sqlQueryBetweenTimesWithPermissions({
                table: 'Events',
                user: user,
                groupKey: req.params.ke,
                monitorId: req.params.id,
                startTime: req.query.start,
                endTime: req.query.end,
                startTimeOperator: req.query.startOperator,
                endTimeOperator: req.query.endOperator,
                limit: req.query.limit,
                endIsStartTo: true,
                parseRowDetails: true,
                noFormat: true,
                noCount: true,
                rowName: 'events',
                preliminaryValidationFailed: (
                    user.permissions.watch_videos === "0" ||
                    hasRestrictions &&
                    (!userDetails.video_view || userDetails.video_view.indexOf(monitorId)===-1)
                )
            },(response) => {
                res.end(s.prettyPrint(response))
            })
        })
    })
    /**
    * API : Get Logs
     */
    app.get([
        config.webPaths.apiPrefix+':auth/logs/:ke',
        config.webPaths.apiPrefix+':auth/logs/:ke/:id'
    ], function (req,res){
        res.setHeader('Content-Type', 'application/json');
        s.auth(req.params,function(user){
            const userDetails = user.details
            const monitorId = req.params.id
            const groupKey = req.params.ke
            const hasRestrictions = userDetails.sub && userDetails.allmonitors !== '1';
            s.sqlQueryBetweenTimesWithPermissions({
                table: 'Logs',
                user: user,
                groupKey: req.params.ke,
                monitorId: req.params.id,
                startTime: req.query.start,
                endTime: req.query.end,
                startTimeOperator: req.query.startOperator,
                endTimeOperator: req.query.endOperator,
                limit: req.query.limit || 50,
                endIsStartTo: true,
                noFormat: true,
                noCount: true,
                rowName: 'logs',
                preliminaryValidationFailed: (
                    user.permissions.get_logs === "0" || userDetails.sub && userDetails.view_logs !== '1'
                )
            },(response) => {
                response.forEach(function(v,n){
                    v.info = JSON.parse(v.info)
                })
                res.end(s.prettyPrint(response))
            })
        },res,req)
    })
    /**
    * API : Get Monitors Online
     */
    app.get(config.webPaths.apiPrefix+':auth/smonitor/:ke', function (req,res){
        var response = {ok:false};
        res.setHeader('Content-Type', 'application/json');
        s.auth(req.params,(user) => {
            const groupKey = req.params.ke
            const monitorId = req.params.id
            const monitorRestrictions = s.getMonitorRestrictions(user.details,monitorId)
            if(user.details.sub && user.details.allmonitors === '0' && (user.permissions.get_monitors === "0" || monitorRestrictions.length === 0)){
                s.closeJsonResponse(res,[]);
                return
            }
            s.knexQuery({
                action: "select",
                columns: "*",
                table: "Monitors",
                where: [
                    ['ke','=',groupKey],
                    monitorRestrictions
                ]
            },(err,r) => {
                const startedMonitors = []
                r.forEach(function(v){
                    if(
                        s.group[groupKey] &&
                        s.group[groupKey].activeMonitors[v.mid] &&
                        s.group[groupKey].activeMonitors[v.mid].isStarted === true
                    ){
                        startedMonitors.push(v)
                    }
                })
                s.closeJsonResponse(res,startedMonitors)
            })
        },res,req);
    });
    /**
    * API : Monitor Mode Controller
     */
    app.get([config.webPaths.apiPrefix+':auth/monitor/:ke/:id/:f',config.webPaths.apiPrefix+':auth/monitor/:ke/:id/:f/:ff',config.webPaths.apiPrefix+':auth/monitor/:ke/:id/:f/:ff/:fff'], function (req,res){
        var response = {ok:false};
        res.setHeader('Content-Type', 'application/json');
        s.auth(req.params,function(user){
            if(user.permissions.control_monitors==="0"||user.details.sub&&user.details.allmonitors!=='1'&&user.details.monitor_edit.indexOf(req.params.id)===-1){
                res.end(user.lang['Not Permitted'])
                return
            }
            if(req.params.f===''){response.msg = user.lang.monitorGetText1;res.end(s.prettyPrint(response));return}
            if(req.params.f!=='stop'&&req.params.f!=='start'&&req.params.f!=='record'){
                response.msg = 'Mode not recognized.';
                res.end(s.prettyPrint(response));
                return;
            }
            s.knexQuery({
                action: "select",
                columns: "*",
                table: "Monitors",
                where: [
                    ['ke','=',req.params.ke],
                    ['mid','=',req.params.id],
                ],
                limit: 1
            },(err,r) => {
                if(r && r[0]){
                    r = r[0];
                    if(req.query.reset==='1'||(s.group[r.ke]&&s.group[r.ke].rawMonitorConfigurations[r.mid].mode!==req.params.f)||req.query.fps&&(!s.group[r.ke].activeMonitors[r.mid].currentState||!s.group[r.ke].activeMonitors[r.mid].currentState.trigger_on)){
                        if(req.query.reset!=='1'||!s.group[r.ke].activeMonitors[r.mid].trigger_timer){
                            if(!s.group[r.ke].activeMonitors[r.mid].currentState)s.group[r.ke].activeMonitors[r.mid].currentState={}
                            s.group[r.ke].activeMonitors[r.mid].currentState.mode=r.mode.toString()
                            s.group[r.ke].activeMonitors[r.mid].currentState.fps=r.fps.toString()
                            if(!s.group[r.ke].activeMonitors[r.mid].currentState.trigger_on){
                               s.group[r.ke].activeMonitors[r.mid].currentState.trigger_on=true
                            }else{
                                s.group[r.ke].activeMonitors[r.mid].currentState.trigger_on=false
                            }
                            r.mode=req.params.f;
                            try{r.details=JSON.parse(r.details);}catch(er){}
                            if(req.query.fps){
                                r.fps=parseFloat(r.details.detector_trigger_record_fps)
                                s.group[r.ke].activeMonitors[r.mid].currentState.detector_trigger_record_fps=r.fps
                            }
                            r.id=r.mid;
                            s.knexQuery({
                                action: "update",
                                table: "Monitors",
                                update: {
                                    mode: r.mode
                                },
                                where: [
                                    ['ke','=',r.ke],
                                    ['mid','=',r.mid],
                                ]
                            })
                            s.group[r.ke].rawMonitorConfigurations[r.mid]=r;
                            s.tx({f:'monitor_edit',mid:r.mid,ke:r.ke,mon:r},'GRP_'+r.ke);
                            s.tx({f:'monitor_edit',mid:r.mid,ke:r.ke,mon:r},'STR_'+r.ke);
                            s.camera('stop',s.cleanMonitorObject(r));
                            if(req.params.f!=='stop'){
                                s.camera(req.params.f,s.cleanMonitorObject(r));
                            }
                            response.msg = user.lang['Monitor mode changed']+' : '+req.params.f;
                        }else{
                            response.msg = user.lang['Reset Timer'];
                        }
                        response.cmd_at=s.formattedTime(new Date,'YYYY-MM-DD HH:mm:ss');
                        response.ok = true;
                        if(req.params.ff&&req.params.f!=='stop'){
                            req.params.ff=parseFloat(req.params.ff);
                            clearTimeout(s.group[r.ke].activeMonitors[r.mid].trigger_timer)
                            switch(req.params.fff){
                                case'day':case'days':
                                    req.timeout=req.params.ff*1000*60*60*24
                                break;
                                case'hr':case'hour':case'hours':
                                    req.timeout=req.params.ff*1000*60*60
                                break;
                                case'min':case'minute':case'minutes':
                                    req.timeout=req.params.ff*1000*60
                                break;
                                default://seconds
                                    req.timeout=req.params.ff*1000
                                break;
                            }
                            s.group[r.ke].activeMonitors[r.mid].trigger_timer=setTimeout(function(){
                                delete(s.group[r.ke].activeMonitors[r.mid].trigger_timer)
                                s.knexQuery({
                                    action: "update",
                                    table: "Monitors",
                                    update: {
                                        mode: s.group[r.ke].activeMonitors[r.mid].currentState.mode
                                    },
                                    where: [
                                        ['ke','=',r.ke],
                                        ['mid','=',r.mid],
                                    ]
                                })
                                r.neglectTriggerTimer=1;
                                r.mode=s.group[r.ke].activeMonitors[r.mid].currentState.mode;
                                r.fps=s.group[r.ke].activeMonitors[r.mid].currentState.fps;
                                s.camera('stop',s.cleanMonitorObject(r),function(){
                                    if(s.group[r.ke].activeMonitors[r.mid].currentState.mode!=='stop'){
                                        s.camera(s.group[r.ke].activeMonitors[r.mid].currentState.mode,s.cleanMonitorObject(r));
                                    }
                                    s.group[r.ke].rawMonitorConfigurations[r.mid]=r;
                                });
                                s.tx({f:'monitor_edit',mid:r.mid,ke:r.ke,mon:r},'GRP_'+r.ke);
                                s.tx({f:'monitor_edit',mid:r.mid,ke:r.ke,mon:r},'STR_'+r.ke);
                            },req.timeout);
    //                        response.end_at=s.formattedTime(new Date,'YYYY-MM-DD HH:mm:ss').add(req.timeout,'milliseconds');
                        }
                     }else{
                        response.msg = user.lang['Monitor mode is already']+' : '+req.params.f;
                    }
                }else{
                    response.msg = user.lang['Monitor or Key does not exist.'];
                }
                res.end(s.prettyPrint(response));
            })
        },res,req);
    })
    /**
    * API : Get Cloud Video File (proxy)
     */
    app.get(config.webPaths.apiPrefix+':auth/cloudVideos/:ke/:id/:file', function (req,res){
        s.auth(req.params,function(user){
            const groupKey = req.params.ke
            const monitorId = req.params.id
            const monitorRestrictions = s.getMonitorRestrictions(user.details,monitorId)
            if(user.details.sub && user.details.allmonitors === '0' && (user.permissions.watch_videos === "0" || monitorRestrictions.length === 0)){
                s.closeJsonResponse(res,{
                    ok: false,
                    msg: lang['Not Permitted']
                })
                return
            }
            var time = s.nameToTime(req.params.file)
            if(req.query.isUTC === 'true'){
                time = s.utcToLocal(time)
            }
            time = new Date(time)
            s.knexQuery({
                action: "select",
                columns: "*",
                table: "Cloud Videos",
                where: [
                    ['ke','=',groupKey],
                    ['mid','=',req.params.id],
                    ['time','=',time]
                ],
                limit: 1
            },(err,r) => {
                if(r&&r[0]){
                    r = r[0]
                    if(JSON.parse(r.details).type === 'googd' && s.cloudDiskUseOnGetVideoDataExtensions['googd']){
                        s.cloudDiskUseOnGetVideoDataExtensions['googd'](r).then((dataPipe) => {
                            dataPipe.pipe(res)
                        }).catch((err) => {
                            console.log(err)
                            res.end(user.lang['File Not Found in Database'])
                        })
                    }else{
                        req.pipe(request(r.href)).pipe(res)
                    }
                }else{
                    res.end(user.lang['File Not Found in Database'])
                }
            })
        },res,req);
    });
    /**
    * API : Get Video File
     */
     const videoRowCaches = {}
     const videoRowCacheTimeouts = {}
    app.get(config.webPaths.apiPrefix+':auth/videos/:ke/:id/:file', function (req,res){
        s.auth(req.params,function(user){
            const groupKey = req.params.ke
            const monitorId = req.params.id
            const monitorRestrictions = s.getMonitorRestrictions(user.details,monitorId)
            if(user.details.sub && user.details.allmonitors === '0' && (user.permissions.watch_videos === "0" || monitorRestrictions.length === 0)){
                s.closeJsonResponse(res,{
                    ok: false,
                    msg: lang['Not Permitted']
                })
                return
            }
            var time = s.nameToTime(req.params.file)
            if(req.query.isUTC === 'true'){
                time = s.utcToLocal(time)
            }
            time = new Date(time)
            const cacheName = Object.values(req.params).join('_')
            const cacheVideoRow = (videoRow) => {
                videoRowCaches[cacheName] = videoRow
                clearTimeout(videoRowCacheTimeouts[cacheName])
                videoRowCacheTimeouts[cacheName] = setTimeout(() => {
                    delete(videoRowCaches[cacheName])
                },60000)
            }
            const sendVideo = (videoRow) => {
                cacheVideoRow(videoRow)
                const filePath = s.getVideoDirectory(videoRow) + req.params.file
                fs.stat(filePath,function(err,stats){
                    if (!err){
                        if(req.query.json === 'true'){
                            s.closeJsonResponse(res,videoRow)
                        }else{
                            s.streamMp4FileOverHttp(filePath,req,res,!!req.query.pureStream)
                        }
                    }else{
                        res.end(user.lang['File Not Found in Filesystem'])
                    }
                })
            }
            if(videoRowCaches[cacheName]){
                sendVideo(videoRowCaches[cacheName])
            }else{
                s.knexQuery({
                    action: "select",
                    columns: "*",
                    table: "Videos",
                    where: [
                        ['ke','=',groupKey],
                        ['mid','=',req.params.id],
                        ['time','=',time]
                    ],
                    limit: 1
                },(err,r) => {
                    const videoRow = r[0]
                    if(videoRow){
                        sendVideo(videoRow)
                    }else{
                        res.end(user.lang['File Not Found in Database'])
                    }
                })
            }
        },res,req);
    });
    /**
    * API : Motion Trigger via GET request
     */
     app.get(config.webPaths.apiPrefix+':auth/motion/:ke/:id', function (req,res){
         s.auth(req.params,function(user){
             const groupKey = req.params.ke
             const monitorId = req.params.id
             const monitorRestrictions = s.getMonitorRestrictions(user.details,monitorId)
             if(user.details.sub && user.details.allmonitors === '0' && monitorRestrictions.length === 0){
                 s.closeJsonResponse(res,{
                     ok: false,
                     msg: lang['Not Permitted']
                 })
                 return
             }
             if(req.query.data){
                 try{
                     var d = {
                         id: req.params.id,
                         ke: req.params.ke,
                         details: s.parseJSON(req.query.data)
                     }
                 }catch(err){
                     s.closeJsonResponse(res,{
                         ok: false,
                         msg: user.lang['Data Broken']
                     })
                     return
                 }
             }else{
                 s.closeJsonResponse(res,{
                     ok: false,
                     msg: user.lang['No Data']
                 })
                 return
             }
             if(!d.ke||!d.id||!s.group[d.ke]){
                 s.closeJsonResponse(res,{
                     ok: false,
                     msg: user.lang['No Group with this key exists']
                 })
                 return
             }
             if(!s.group[d.ke].rawMonitorConfigurations[d.id]){
                 s.closeJsonResponse(res,{
                     ok: false,
                     msg: user.lang['Monitor or Key does not exist.']
                 })
                 return
             }
             var details = s.group[d.ke].rawMonitorConfigurations[d.id].details
             var detectorHttpApi = details.detector_http_api
             var detectorOn = (details.detector === '1')
             switch(detectorHttpApi){
                 case'0':
                     s.closeJsonResponse(res,{
                         ok: false,
                         msg: user.lang['Trigger Blocked']
                     })
                    return
                 break;
                 case'2':
                    if(!detectorOn){
                        s.closeJsonResponse(res,{
                            ok: false,
                            msg: user.lang['Trigger Blocked']
                        })
                        return
                    }
                 break;
                 case'2':
                    if(detectorOn){
                        s.closeJsonResponse(res,{
                            ok: false,
                            msg: user.lang['Trigger Blocked']
                        })
                        return
                    }
                 break;
             }
             triggerEvent(d)
             s.closeJsonResponse(res,{
                 ok: true,
                 msg: user.lang['Trigger Successful']
             })
         },res,req)
     })
    /**
    * API : WebHook Tester
     */
    app.get(config.webPaths.apiPrefix+':auth/hookTester/:ke/:id', function (req,res){
        res.setHeader('Content-Type', 'application/json');
        s.auth(req.params,function(user){
            s.userLog(req.params,{type:'Test',msg:'Hook Test'})
            res.end(s.prettyPrint({ok:true}))
        },res,req);
    })
    /**
    * API : Object Detection Counter Status
     */
    app.get(config.webPaths.apiPrefix+':auth/eventCountStatus/:ke/:id', function (req,res){
        res.setHeader('Content-Type', 'application/json');
        s.auth(req.params,function(user){
            if(user.permissions.watch_videos==="0"||user.details.sub&&user.details.allmonitors!=='1'&&user.details.monitors.indexOf(req.params.id)===-1){
                res.end(user.lang['Not Permitted'])
                return
            }
            var selectedObject = s.group[req.params.ke].activeMonitors[req.params.id].eventsCounted
            res.end(s.prettyPrint({
                ok: true,
                counted: Object.keys(selectedObject).length,
                tags: selectedObject,
            }))
        },res,req)
    })
    /**
    * API : Object Detection Counter Status
     */
    app.get([
        config.webPaths.apiPrefix+':auth/eventCounts/:ke',
        config.webPaths.apiPrefix+':auth/eventCounts/:ke/:id'
    ], function (req,res){
        res.setHeader('Content-Type', 'application/json')
        s.auth(req.params,function(user){
            const userDetails = user.details
            const monitorId = req.params.id
            const groupKey = req.params.ke
            var hasRestrictions = userDetails.sub && userDetails.allmonitors !== '1';
            s.sqlQueryBetweenTimesWithPermissions({
                table: 'Events Counts',
                user: user,
                noCount: true,
                groupKey: req.params.ke,
                monitorId: req.params.id,
                startTime: req.query.start,
                endTime: req.query.end,
                startTimeOperator: req.query.startOperator,
                endTimeOperator: req.query.endOperator,
                limit: req.query.limit,
                archived: req.query.archived,
                endIsStartTo: !!req.query.endIsStartTo,
                parseRowDetails: true,
                rowName: 'counts',
                preliminaryValidationFailed: (
                    user.permissions.watch_videos === "0" ||
                    hasRestrictions &&
                    (!userDetails.video_view || userDetails.video_view.indexOf(monitorId)===-1)
                )
            },(response) => {
                res.end(s.prettyPrint(response))
            })
        },res,req)
    })
    /**
    * API : Camera PTZ Controller
     */
    app.get(config.webPaths.apiPrefix+':auth/control/:ke/:id/:direction', function (req,res){
        res.setHeader('Content-Type', 'application/json');
        s.auth(req.params,function(user){
            if(req.params.direction === 'setHome'){
                setPresetForCurrentPosition({
                    id: req.params.id,
                    ke: req.params.ke,
                },(response) => {
                    res.end(s.prettyPrint(response))
                })
            }else{
                ptzControl(req.params,function(msg){
                    s.userLog({
                        id: req.params.id,
                        ke: req.params.ke,
                    },{
                        msg: msg,
                        direction: req.params.direction,
                    })
                    res.end(s.prettyPrint(msg))
                })
            }
        },res,req);
    })
    /**
    * API : Upload Video File
    * API : Add "streamIn" query string to Push to "Dashcam (Streamer v2)" FFMPEG Process
     */
    app.post(config.webPaths.apiPrefix+':auth/videos/:ke/:id',fileupload(), async (req,res) => {
        var response = {ok:false}
        res.setHeader('Content-Type', 'application/json');
        s.auth(req.params,function(user){
            if(user.permissions.watch_videos==="0"||user.details.sub&&user.details.allmonitors!=='1'&&user.details.video_delete.indexOf(req.params.id)===-1){
                res.end(user.lang['Not Permitted'])
                return
            }
            var groupKey = req.params.ke
            var monitorId = req.params.id
            // req.query.overwrite === '1'
            if(s.group[groupKey] && s.group[groupKey].activeMonitors && s.group[groupKey].activeMonitors[monitorId]){
                var monitor = s.group[groupKey].rawMonitorConfigurations[monitorId]
                try {
                    if(!req.files) {
                        res.send({
                            status: false,
                            message: 'No file uploaded'
                        });
                    } else {
                        let video = req.files.video;
                        var time = new Date(parseInt(video.name.split('.')[0]))
                        var filename = s.formattedTime(time) + '.' + monitor.ext
                        video.mv(s.getVideoDirectory(monitor) + filename,function(){
                            s.insertCompletedVideo(monitor,{
                                file: filename,
                                events: s.group[groupKey].activeMonitors[monitorId].detector_motion_count,
                                endTime: req.body.endTime.indexOf('-') > -1 ? s.nameToTime(req.body.endTime) : parseInt(req.body.endTime) || null,
                            },function(){
                                response.ok = true
                                response.filename = filename
                                res.end(s.prettyPrint({
                                    ok: true,
                                    message: 'File is uploaded',
                                    data: {
                                        name: video.name,
                                        mimetype: video.mimetype,
                                        size: video.size
                                    }
                                }))
                            })
                        });
                    }
                } catch (err) {
                    response.err = err
                    res.status(500).end(response)
                }
            }else{
                response.error = 'Non Existant Monitor'
                res.end(s.prettyPrint(response))
            }
        },res,req);
    })
    /**
    * API : Modify Video File
     */
    app.get([
        config.webPaths.apiPrefix+':auth/videos/:ke/:id/:file/:mode',
        config.webPaths.apiPrefix+':auth/videos/:ke/:id/:file/:mode/:f',
        config.webPaths.apiPrefix+':auth/cloudVideos/:ke/:id/:file/:mode',
        config.webPaths.apiPrefix+':auth/cloudVideos/:ke/:id/:file/:mode/:f'
    ], function (req,res){
        var response = {ok:false};
        res.setHeader('Content-Type', 'application/json');
        s.auth(req.params,function(user){
            if(user.permissions.watch_videos==="0"||user.details.sub&&user.details.allmonitors!=='1'&&user.details.video_delete.indexOf(req.params.id)===-1){
                res.end(user.lang['Not Permitted'])
                return
            }
            var time = s.nameToTime(req.params.file)
            if(req.query.isUTC === 'true'){
                time = s.utcToLocal(time)
            }
            time = new Date(time)
            var origURL = req.originalUrl.split('/')
            var videoParam = origURL[origURL.indexOf(req.params.auth) + 1]
            var videoSet = 'Videos'
            switch(videoParam){
                case'cloudVideos':
                    videoSet = 'Cloud Videos'
                break;
            }
            const groupKey = req.params.ke
            const monitorId = req.params.id
            s.knexQuery({
                action: "select",
                columns: "*",
                table: videoSet,
                where: [
                    ['ke','=',groupKey],
                    ['mid','=',req.params.id],
                    ['time','=',time]
                ],
                limit: 1
            },(err,r) => {
                if(r && r[0]){
                    r=r[0];
                    r.filename=s.formattedTime(r.time)+'.'+r.ext;
                    var details = s.parseJSON(r.details) || {}
                    switch(req.params.mode){
                        case'fix':
                            response.ok = true;
                            s.video('fix',r)
                        break;
                        case'status':
                            r.f = 'video_edit'
                            switch(videoParam){
                                case'cloudVideos':
                                    r.f += '_cloud'
                                break;
                            }
                            r.status = parseInt(req.params.f)
                            if(isNaN(req.params.f)||req.params.f===0){
                                response.msg = 'Not a valid value.';
                            }else{
                                response.ok = true;
                                s.knexQuery({
                                    action: "update",
                                    table: videoSet,
                                    update: {
                                        status: req.params.f
                                    },
                                    where: [
                                        ['ke','=',groupKey],
                                        ['mid','=',req.params.id],
                                        ['time','=',time]
                                    ]
                                })
                                s.tx(r,'GRP_'+r.ke);
                            }
                        break;
                        case'delete':
                            response.ok = true;
                            switch(videoParam){
                                case'cloudVideos':
                                    s.deleteVideoFromCloud(r,details.type || 's3')
                                break;
                                default:
                                    s.deleteVideo(r)
                                break;
                            }
                        break;
                        default:
                            response.msg = user.lang.modifyVideoText1;
                        break;
                    }
                }else{
                    response.msg = user.lang['No such file'];
                }
                res.end(s.prettyPrint(response));
            })
        },res,req);
    })
    /**
    * API : Get Login Tokens
     */
    app.get(config.webPaths.apiPrefix+':auth/loginTokens/:ke', function (req,res){
        var response = {ok:false};
        res.setHeader('Content-Type', 'application/json');
        s.auth(req.params,(user) => {
            const groupKey = req.params.ke
            s.knexQuery({
                action: "select",
                columns: "*",
                table: "LoginTokens",
                where: [
                    ['ke','=',groupKey],
                    ['uid','=',user.uid],
                ]
            },(err,rows) => {
                response.ok = true
                response.rows = rows
                s.closeJsonResponse(res,response)
            })
        },res,req);
    });
    /**
    * API : Get Login Token
     */
    app.get(config.webPaths.apiPrefix+':auth/loginTokens/:ke/:loginId', function (req,res){
        var response = {ok:false};
        res.setHeader('Content-Type', 'application/json');
        s.auth(req.params,(user) => {
            const groupKey = req.params.ke
            s.knexQuery({
                action: "select",
                columns: "*",
                table: "LoginTokens",
                where: [
                    ['loginId','=',user.uid],
                    ['ke','=',groupKey],
                    ['uid','=',user.uid],
                ],
                limit: 1
            },(err,rows) => {
                response.ok = !!rows[0]
                response.row = rows[0]
                s.closeJsonResponse(res,response)
            })
        },res,req);
    });
    /**
    * API : Delete Login Token
     */
    app.get(config.webPaths.apiPrefix+':auth/loginTokens/:ke/:loginId/delete', function (req,res){
        var response = {ok:false};
        res.setHeader('Content-Type', 'application/json');
        s.auth(req.params,async (user) => {
            const loginId = req.params.loginId
            const groupKey = req.params.ke
            const deleteResponse = await s.knexQueryPromise({
                action: "delete",
                table: "LoginTokens",
                where: [
                    ['loginId','=',loginId],
                    ['ke','=',groupKey],
                    ['uid','=',user.uid],
                ]
            })
            response.ok = true
            s.closeJsonResponse(res,response)
        },res,req);
    });
    /**
    * API : Stream In to push data to ffmpeg by HTTP
     */
    app.all('/:auth/streamIn/:ke/:id', function (req, res) {
        s.auth(req.params,function(user){
            const ipAddress = s.getClientIp(req)
            const groupKey = req.params.ke
            const monitorId = req.params.id
            const timeStartedConnection = new Date();
            s.userLog({
                ke: groupKey,
                mid: monitorId,
            },{
                type: "HTTP streamIn Started",
                msg: {
                    ipAddress: ipAddress,
                }
            })
            res.connection.setTimeout(0);
            req.on('data', function(buffer){
                s.group[groupKey].activeMonitors[monitorId].spawn.stdin.write(buffer)
            });
            req.on('end',function(){
                s.userLog({
                    ke: groupKey,
                    mid: monitorId,
                },{
                    type: "HTTP streamIn Closed",
                    msg: {
                        timeStartedConnection: timeStartedConnection,
                        ipAddress: ipAddress,
                    }
                })
            });
        },res,req)
    })
    /**
    * API : Account Edit from Dashboard
     */
    app.all(config.webPaths.apiPrefix+':auth/accounts/:ke/edit',function (req,res){
        s.auth(req.params,function(user){
            var endData = {
                ok : false
            }
            var form = s.getPostData(req)
            if(form){
                endData.ok = true
                s.accountSettingsEdit({
                    ke: req.params.ke,
                    uid: user.uid,
                    form: form,
                    cnid: user.cnid
                })
            }else{
                endData.msg = lang.postDataBroken
            }
            s.closeJsonResponse(res,endData)
        },res,req)
    })
    /**
    * API : Get Definitions JSON
     */
    app.get(config.webPaths.apiPrefix+':auth/definitions/:ke',function (req,res){
        s.auth(req.params,function(user){
            var endData = {
                ok: true,
                definitions: s.getDefinitonFile(user.details.lang)
            }
            s.closeJsonResponse(res,endData)
        },res,req)
    })
    /**
    * API : Get Language JSON
     */
    app.get(config.webPaths.apiPrefix+':auth/language/:ke',function (req,res){
        s.auth(req.params,function(user){
            var endData = {
                ok: true,
                definitions: s.getLanguageFile(user.details.lang)
            }
            s.closeJsonResponse(res,endData)
        },res,req)
    })
    /**
    * Robots.txt
    */
    app.get('/robots.txt', function (req,res){
        res.on('finish',function(){
            res.end()
        })
        fs.createReadStream(s.mainDirectory + '/web/pages/robots.txt').pipe(res)
    })
}
