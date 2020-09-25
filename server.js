const fs   = require("fs"),
      express = require("express"),
      app = express(),
      bodyParser = require("body-parser"),
      passport = require("passport"),
      cors = require("cors"),
      port = 3000;

require("dotenv").config();
app.use(cors());
let GitHubStrategy = require('passport-github').Strategy;
passport.use(new GitHubStrategy({
        clientID: process.env.clientID,
        clientSecret: process.env.clientSecret,
        callbackURL: `${process.env.callbackURL}`
    },
    function(accessToken, refreshToken, profile, cb) {
        console.log("profile: " + profile);
        cb();
        //User.findOrCreate({ githubId: profile.id }, function (err, user) {
        //  return cb(err, user);
        //});
    }
));

app.get('/auth/github', cors(), passport.authenticate('github'));
app.get('/auth/github/callback', cors(),
    passport.authenticate('github', { failureRedirect: '/login' }),
    function(req, res) {
        console.log("here");
        // Successful authentication, redirect home.
        res.redirect('/');
    }
);

const MongoClient = require('mongodb').MongoClient;
const uri = `mongodb+srv://${process.env.name}:${process.env.password}@cs4241-a3.catjb.gcp.mongodb.net/CS4241?retryWrites=true&w=majority`;
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });
client.connect(err => {
    if(err){
        console.log("error connecting to database: " +err);
    }
});

app.listen(port);
app.use(express.static("./public"));

//Format: { "id": 0, "kills": 0, "assists": 0, "deaths": 0, "kd_ratio": 0, "ad_ratio": 0 },
let appdata = [];
const DECIMAL_PRECISION = 2;

let id = 1;//Unique IDs to indicate rows to modify or delete
let numEntries = 0;//Length of appdata

//Track running totals and averages of all three main stats
let totalKills = 0;
let totalAssists = 0;
let totalDeaths = 0;
let avgKills = 0;
let avgAssists = 0;
let avgDeaths = 0;

/////////////////// Additional Middleware /////////////////////////////
/**
 * Converts the stats given in the HTTP request to Numbers, and stores
 * them back into <b>request.body</b>.
 *
 * @param request the HTTP request to convert "id," "kills," "assists"
 *     and "deaths" fields to Numbers.
 * @param response the HTTP response to be populated with the results of
 *     the request (will not be modified by this function).
 * @param next the next middleware function the call
 */
const convertDataToNum = function(request, response, next){
    console.log(request.body);
    if(request.body.hasOwnProperty("id"))
        request.body.id = parseInt(request.body.id, 10);

    if(request.body.hasOwnProperty("kills"))
        request.body.kills = parseInt(request.body.kills, 10);

    if(request.body.hasOwnProperty("assists"))
        request.body.assists = parseInt(request.body.assists, 10);

    if(request.body.hasOwnProperty("deaths"))
        request.body.deaths = parseInt(request.body.deaths, 10);

    next();
}
///////////////////////////////////////////////////////////////////////

////////////////////// POST Request Handlers //////////////////////////
/**
 * Add the item stored in <b>data</b> into the appdata table. This set
 * of stats is assigned an unique ID number as well.
 *
 * @param request the HTTP response contain the data to add to the table
 * @param response the HTTP response to be populated with the results of
 *     the request
 * @return {boolean} true on successful addition, false otherwise
 */
const addItem = function(request, response){
    if (Number.isNaN(request.body.kills) || request.body.kills < 0 ||
        Number.isNaN(request.body.assists) || request.body.assists < 0 ||
        Number.isNaN(request.body.deaths) || request.body.deaths < 0){
            response.writeHead(400, "Add request failed", {"Content-Type": "text/plain"});
            response.end();
            return false;
    }

    let ratios = calculateKDandAD(request.body.kills, request.body.assists, request.body.deaths);
    let obj = {
        "_id": id,
        "kills": request.body.kills,
        "assists": request.body.assists,
        "deaths": request.body.deaths,
        "kd_ratio": ratios.kd_ratio,
        "ad_ratio": ratios.ad_ratio
    };

    id++;
    update(1, request.body.kills, request.body.assists, request.body.deaths);

    let collection = client.db("FPS_Stats").collection("game_stats");
    collection.insertOne(obj, {}, function(error, result){
        if(error){
            console.log("error occurred adding item: " +error);
            return;
        }
        sendTable(response);
    });
}
app.post("/add", [bodyParser.json(), convertDataToNum], addItem);

/**
 * Modify the row in the appdata table with the given id to instead
 * have the stats stored in <b>data</b>. This set of stats will keep
 * the unique ID number that was assigned to it when it was added.
 *
 * @param request the HTTP response contain the data to modify in the table
 * @param response the HTTP response to be populated with the results of
 *     the request
 * @return {boolean} true on successful modification, false otherwise.
 */
const modifyItem = function(request, response){
    let game_stats = client.db("FPS_Stats").collection("game_stats");
    game_stats.findOne({_id: request.body.id}, {}, function(error, result){
        if(error){
            console.log("Error finding element to modify: " +error);
            return;
        }else if(!result){
            console.log("Did not find element with specified ID");
            return;
        }

        totalKills -= result.kills;
        totalAssists -= result.assists;
        totalDeaths -= result.deaths;

        let updateData = {
            kills: result.kills,
            assists: result.assists,
            deaths: result.deaths
        };

        //Modify only the fields that were provided
        if(!Number.isNaN(request.body.kills) && request.body.kills >= 0)
            updateData.kills = request.body.kills;
        if(!Number.isNaN(request.body.assists) && request.body.assists >= 0)
            updateData.assists = request.body.assists;
        if(!Number.isNaN(request.body.deaths) && request.body.deaths >= 0)
            updateData.deaths = request.body.deaths;

        //Recalculate derived fields
        let ratios = calculateKDandAD(updateData.kills, updateData.assists, updateData.deaths);
        updateData.kd_ratio = ratios.kd_ratio;
        updateData.ad_ratio = ratios.ad_ratio;

        update(0, updateData.kills, updateData.assists, updateData.deaths);

        game_stats.updateOne({_id: request.body.id}, {$set: updateData}, function(error, result){
            if(error){
                console.log("Error occurred modifying item: " +error);
            }else{
                sendTable(response);
            }
        });
    });
}
app.post("/modify", [bodyParser.json(), convertDataToNum], modifyItem);

/**
 * Delete the row in the appdata table with the given id.
 *
 * @param request the HTTP response contain the ID of the row to delete
 *     from the table
 * @param response the HTTP response to be populated with the results of
 *     the request
 * @return {boolean} true on successful deletion, false otherwise.
 */
const deleteItem = function(request, response){
    if(Number.isNaN(request.body.id) || request.body.id < 0)
        return false;

    let game_stats = client.db("FPS_Stats").collection("game_stats");
    game_stats.findOne({_id:request.body.id}, function(error, result){
        if(error){
            console.log("Error occurred finding element to delete: " +error);
            return;
        }

        update(-1, -result.kills, -result.assists, -result.deaths, response);

        //Once we have successfully found the item to delete, update totals and averages,
        //and THEN it's safe to delete.
        game_stats.deleteOne({_id: request.body.id}, function (error, result) {
            if (error) {
                console.log("Error occurred during deletion: " + error);
            }else{
                sendTable(response);
            }
        });
    });
}
app.post("/delete", [bodyParser.json(), convertDataToNum], deleteItem);
//////////////////////////////////////////////////////////////////////


/////////////////////// GET Request Handlers //////////////////////////
/**
 * Creates an HTTP response with a JSON object that contains all the data for the
 * total_avg_results and result_list tables in index.html. This includes every
 * row of appdata as well as total and average number of kills, assists and deaths.
 * This JSON object is then stored in <b>response</b> and the headers are set.
 *
 * The format of the JSON object is as follows:
 * {
 *     numRows: ,
 *     rows: [
 *         { "id": , "kills": , "assists": , "deaths": , "kd_ratio": , "ad_ratio": },
 *         ...
 *         { "id": , "kills": , "assists": , "deaths": , "kd_ratio": , "ad_ratio": },
 *     ],
 *     totals_avgs: {
 *         total_kills:
 *         avg_kills:
 *         total_assists:
 *         avg_assists:
 *         total_deaths:
 *         avg_deaths:
 *     }
 * }
 *
 * @param response an HTTP response that will populated with a JSON object that
 *      contains every row of appdata as well as total and average number of kills,
 *      assists and deaths.
 */
const sendTable = function(response){
    let json = {
        "numRows": numEntries,
        "rows": [],
        "totals": [],
        "avgs": [],
    }
    getAllStats().then(function(result){
            json["rows"] = result;
            json["totals"] = {
                kills: totalKills,
                assists: totalAssists,
                deaths: totalDeaths
            }
            json["avgs"] = {
                kills: avgKills,
                assists: avgAssists,
                deaths: avgDeaths
            }
            response.json(json);
    });
}
app.get('/results', function(request, response){
    sendTable(response);
});

const getAllStats = function(){
    let game_stats = client.db("FPS_Stats").collection("game_stats");
    return game_stats.find({}).toArray();
}

/**
 * Creates an HTTP response that contains the contents of a stats.csv file,
 * which is a csv file that contains every row of appdata as well as total
 * and average number of kills, assists and deaths. This response is then
 * stored in <b>response</b> and the headers are set.
 *
 * @param response an HTTP response that will be populated the data for stats.csv.
 */
const sendCSV = function(response){
    /*
     * The following link from node.js documentation taught how to
     * close and flush write streams: https://nodejs.org/api/stream.html
     */
    let file = fs.createWriteStream("./stats.csv");
    file.write(",Total,Average\n");
    file.write(`Kills,${totalKills},${avgKills}\n`);
    file.write(`Assists,${totalAssists},${avgAssists}\n`);
    file.write(`Deaths,${totalDeaths},${avgDeaths}\n\n`);

    file.write("ID #,Kills,Assists,Deaths,K/D Ratio,A/D Ratio\n");
    for(let i = 0; i < numEntries; i++){
        file.write(`${appdata[i]["id"]}, ${appdata[i]["kills"]}, ${appdata[i]["assists"]}, ${appdata[i]["deaths"]}, ${appdata[i]["kd_ratio"]}, ${appdata[i]["ad_ratio"]}\n`);
    }
    file.on("finish", function(){
        //Whole file has now been written, so send.
        response.sendFile("./stats.csv", {root: "./" }, function(error){
            if(error){
                console.log("Error occurred sending file: " +error);
            }
        });
    });
    file.end();
}
app.get('/csv', function(request, response){
    sendCSV(response);
});

/**
 * Wipe all the data stored on the server and reset count variables.
 * Return an a json indicating an empty table so index.html knows to
 * display and empty table.
 *
 * @param response an HTTP response that will be populate with an
 *     empty table to indicate that server data has been wiped.
 */
const clearStats = function(response){
    function handleClear(error, result){
        if(error){
            console.log("error occurred during clear: " +error);
        }
    }

    id = 1;
    numEntries = 0;

    //Set all running stats back to zero
    let total = client.db("FPS_Stats").collection("totals");
    total.updateMany({type: {$in: ["kills", "assists", "deaths", "entries"]}}, {$set: {amount: 0}}, handleClear);

    let avgs = client.db("FPS_Stats").collection("averages");
    avgs.updateMany({type: {$in: ["kills", "assists", "deaths"]}}, {$set: {amount: 0}}, handleClear);

    //Clear the entire game_stats collection
    let game_stats = client.db("FPS_Stats").collection("game_stats");
    game_stats.deleteMany({}, handleClear);
    sendTable(response);
}
app.get('/clear', function(request, response){
    clearStats(response);
});
///////////////////////////////////////////////////////////////////////

////////////////////// Data Processing ////////////////////////////////
/**
 * Calculates the kill/death ratio and assist/death ratio based on the
 * given set of <b>kills</b>, <b>assists</b> and <b>deaths</b>.
 *
 * @param kills number of kills from the game
 * @param assists number of assists from the game
 * @param deaths number of deaths from the game
 */
const calculateKDandAD = function(kills, assists, deaths){
    let kd, ad;
    //We want to avoid divide by zero errors, but still allows for 0 deaths.
    //If there are 0 deaths, FPS games traditionally treat K/D = # kill and
    //A/D as assists
    if(deaths === 0) {
        kd = kills;
        ad = assists;
    }else{
        kd = parseFloat((kills / deaths).toFixed(DECIMAL_PRECISION));
        ad = parseFloat((assists / deaths).toFixed(DECIMAL_PRECISION));
    }
    return {
        kd_ratio: kd,
        ad_ratio: ad
    }
}

/**
 * Update the total and average kills, assists and deaths by taking into
 * account the new set of <b>kills</b>, <b>assists</b> and <b>deaths</b>.
 *
 * @param kills number of kills from the game
 * @param assists number of assists from the game
 * @param deaths number of deaths from the game
 */
const updateTotals = function(kills, assists, deaths){
    console.log("kills: " +kills);
    totalKills += kills;
    console.log("totalKills: " + totalKills);
    totalAssists += assists;
    totalDeaths += deaths;
    let totals = client.db("FPS_Stats").collection("totals");
    let promises = [];
    promises.push(totals.updateOne({type: "kills"}, {$inc: {amount: kills}}, {}));
    promises.push(totals.updateOne({type: "assists"}, {$inc: {amount: assists}}, {}));
    promises.push(totals.updateOne({type: "deaths"}, {$inc: {amount: deaths}}, {}));
    return Promise.all(promises);
}

/**
 * Update the average kills, assists and deaths based on the current number
 * of kills, assists and deaths.
 */
const updateAvgs = function() {
    if(numEntries <= 0){
        numEntries = 0;
        avgKills = 0;
        avgAssists = 0;
        avgDeaths = 0;
    }else{
        avgKills = parseFloat((totalKills / numEntries).toFixed(DECIMAL_PRECISION));
        avgAssists = parseFloat((totalAssists / numEntries).toFixed(DECIMAL_PRECISION));
        avgDeaths = parseFloat((totalDeaths / numEntries).toFixed(DECIMAL_PRECISION));
    }
    let avgs = client.db("FPS_Stats").collection("averages");
    let promises = [];
    promises.push(avgs.updateOne({type: "kills"}, {$inc: {amount: avgKills}}, {}));
    promises.push(avgs.updateOne({type: "assists"}, {$inc: {amount: avgAssists}}, {}));
    promises.push(avgs.updateOne({type: "deaths"}, {$inc: {amount: avgDeaths}}, {}));
    return Promise.all(promises);
}

const updateNumEntries = function(delta){
    numEntries += delta;
    let totals = client.db("FPS_Stats").collection("totals");
    return totals.updateOne({type: "entries"}, {$inc: {amount: delta}});
}

const update = function(entriesDelta, kills, assists, deaths){
    updateNumEntries(entriesDelta);
    updateTotals(kills, assists, deaths);
    updateAvgs();
}