var Opmlparser = require('opmlparser')
, opmlparser = new Opmlparser()
, FeedParser = require('feedparser')
, fs = require('fs')
, redis = require('redis').createClient()
, url = require('url')
, http = require('http')
, request = require('request')
, hash = require('./articles.js').hash
, AWS = require('aws-sdk')
AWS.config.loadFromPath('./aws-config.json')
var s3 = new AWS.S3({params:{Bucket:'articles.feedreader.co'}})

exports.post = function(req,res) {
  if (req.body.xmlurl) {
    redis.sadd('folder:'+req.user+'/Other','feed:'+req.body.xmlurl,function(e){
      if (e) res.json({'success':false,'error':{'type':'Redis Error','message':"Couldn't add "+req.body.xmlurl+" to folder:"+req.user+"/Other"}},500)
      else redis.sadd('folders:'+req.user,'folder:'+req.user+'/Other',function(e){
        if (e) res.json({'success':false,'error':{'type':'Redis Error','message':"Couldn't add Others to folders:"+req.user}},500)
        else redis.hmset('feed:'+req.body.xmlurl,'key',req.body.xmlurl,'title',req.body.title,'link',req.body.link,function(e){
          if (e) res.json({'success':false,'error':{'type':'Redis Error','message':"Couldn't store details for feed:"+req.body.xmlurl}},500)
          else res.json({'success':true})
        })
      })
    })
  }
  else if (req.files.opml) {
    opmlparser.parseStream(fs.createReadStream(req.files.opml.path),function(e,meta,feeds,outline){
      if (e) res.json({'success':false,'error':{'type':'Opmlparser Error','message':"Couldn't parse "+req.files.opml.path}},500)
      else feeds.forEach(function(feed){
        if (!feed.folder) feed.folder = 'Other'
        redis.sadd('folder:'+req.user+'/'+feed.folder,'feed:'+feed.xmlUrl,function(e){
          if (e) res.json({'success':false,'error':{'type':'Redis Error','message':"Couldn't set "+feed.xmlUrl+" in folder:"+req.user+"/"+feed.folder}},500)
          else redis.sadd('folders:'+req.user,'folder:'+req.user+'/'+feed.folder,function(e){
            if (e) res.json({'success':false,'error':{'type':'Redis Error','message':"Couldn't add "+feed.folder+" to folders:"+req.user}},500)
            else redis.hmset('feed:'+feed.xmlUrl,'title',feed.title,'link',feed.htmlUrl,function(e){
              if (e) res.json({'success':false,'error':{'type':'Redis Error','message':"Couldn't store details for feed:"+feed.xmlUrl}},500)
              else res.json({'success':true})
            })
          })
        })
      })
    })
  }
  else res.json({'success':false,'error':{'type':'Missing Parameter Error','message':"url or opml required"}},400)
}
exports.get = function(req,res) {
  redis.smembers('folders:'+req.params.user,function(e,folders){
    var feeds = []
    if (e) res.json({'success':false,'error':{'type':'Redis Error','message':"Couldn't get folders for "+req.params.user}},500)
    else redis.sunion(folders,function(e,feedkeys){
     if (e) res.json({'success':false,'error':{'type':'Redis Error','message':"Couldn't get feeds from all folders for "+req.params.user}},500)
     else {
       var feedurls = feedkeys.map(function(feedkey){ return feedkey.substr(5)})
       , unionkeys = feedurls.map(function(feedkey){return 'articles:'+feedkey}).concat('label:'+req.params.user+'/read')
       , weights = feedurls.map(function(){return -1}).concat(1)
       redis.zunionstore(['articles:'+req.params.user,unionkeys.length].concat(unionkeys,'weights',weights,'aggregate','max'),function(e){
         if (e) res.json({'success':false,'error':{'type':'Redis Error','message':"Couldn't create article list for "+req.params.user,'log':e.message}},500)
         else redis.zrangebyscore('articles:'+req.params.user,'-inf','0',function(e,articles){
           if (e) res.json({'success':false,'error':{'type':'Redis Error','message':"Couldn't get article list for "+req.params.user}},500)
           else redis.del('articles:'+req.params.user,function(e){
             if (e) res.json({'success':false,'error':{'type':'Redis Error','message':"Couldn't delete article list for "+req.params.user}},500)
             else feedurls.forEach(function(feedurl,feedurlPosition){
               redis.hgetall('feed:'+feedurl,function(e,feed) {
                 if (!feed) feed = {}
                 feed.key = feedurl
                 feeds.push(feed)
                 var article_ids = articles.map(function(key){return key.substr(8)})
                 if (feedurlPosition === feedurls.length - 1) res.json({'success':true,'feeds':feeds,'articles':article_ids})
               })
             })
           })
         })
       })
      }
    })
  })
}
exports.feed = {}
exports.feed.get = function(req,res) {
  var feedrequested = decodeURIComponent(req.url.slice(7,-5))
  redis.hgetall('feed:'+feedrequested,function(e,feed) {
    if ((e)||(!feed)) res.json({'success':false,'error':{'type':'Redis Error','message':"Couldn't get details for feed:"+feedrequested}},500)
    else {
      var unread = []
      , headers = {'user-agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_8_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/31.0.1650.63 Safari/537.36'
        , 'accept':'text/html,application/xhtml+xml'}
      if (feed.lastModified) headers['If-Modified-Since'] = feed.lastModified
      if (feed.etag) headers['If-None-Match'] = feed.etag
      var req = request({'uri':feedrequested,'headers':headers})
      var feedparser = new FeedParser()
      req.on('error', function(e){
        res.json({'success':false,'error':{'type':'Feed Error','message':"Couldn't get "+feedrequested+" ("+e.message+")",'log':e}},500)
      })
      req.on('response', function(response) {
        redis.hmset('feed:'+feedrequested,'lastModified',response.headers['Last-Modified'],'etag',response.headers['Etag'],function(e){
          if (e) res.json({'success':false,'error':{'type':'Redis Error','message':"Couldn't set lastModified and etag values for "+feedrequested}},500)
          else response.pipe(feedparser)
        })
      })
      feedparser.on('error', function(e) {
        res.json({'success':false,'error':{'type':'Parser Error','message':"Couldn't parse the server response",'log':e}},500)
      })
      feedparser.on('end', function() {
        redis.zrevrange('articles:'+feedrequested,0,-1,function(e,all_articles){
          if (e) res.json({'success':false,'error':{'type':'Redis Error','message':"Couldn't get articles for "+feedrequested}},500)
          else {
            feed.success = true
            feed.articles = all_articles.map(function(key){return key.substr(8)})
            res.json(feed,200)
          }
        })
      })
      feedparser.on('meta', function (meta) {
        redis.hmset('feed:'+feedrequested,'title',meta.title,'link',meta.link,function(e){
          if (e) res.json({'success':false,'error':{'type':'Redis Error','message':"Couldn't set title and link values for "+feedrequested}},500)
        })
      })
      feedparser.on('readable', function() {
        var stream = this, article
        while (article = stream.read()) {
          article.hash = hash(article)
          article.feedurl = feedrequested
          var body = JSON.stringify(article)
          s3.putObject({Key:article.hash
            , Body:body
            , ContentType:'application/json'
          }
          , function (e,d) {
            var article_date = article.pubDate || article.pubdate || article.date
            , score = Date.parse(article_date) || Date.now()
            if (e) res.json({'success':false,'error':{'type':'S3 Error','message':"Couldn't put "+article.hash+" on articles.feedreader.co",'log':e}},500)
            else redis.zadd('articles:'+feedrequested,score,'article:'+article.hash,function(e){
              if (e) res.json({'success':false,'error':{'type':'Redis Error','message':"Couldn't add article:"+article.hash+" to articles:"+feedrequested,'log':e.message}},500)
            })
          })
        }
      })
    }
  })
}
