var state = "IDLE";
var state_last = "";
var graph = [ 'profile', 'live'];
var points = [];
var profiles = [];
var time_mode = 0;
var selected_profile = 0;
var selected_profile_name = 'cone-05-long-bisque.json';
var temp_scale = "c";
var time_scale_slope = "s";
var time_scale_profile = "s";
var time_scale_long = "Seconds";
var temp_scale_display = "C";
var kwh_rate = 0.26;
var currency_type = "EUR";
var run_log = []
var manual_hold = false;
var segment_editor_count = -1;
var segment_signature = "";
var segments_armed = false;       // Edit button toggled on (graph clickable)
var selected_segment = -1;        // the one segment currently unlocked to edit
var segment_end_times = [];        // nominal end time (s) of each segment, for click mapping
var graph_start_ms = null;        // wall-clock (ms) corresponding to runtime=0, for clock-time axis

var protocol = 'ws:';
if (window.location.protocol == 'https:') {
    protocol = 'wss:';
}
var host = "" + protocol + "//" + window.location.hostname + ":" + window.location.port;
// sockets are created (and re-created on disconnect) in document.ready
var ws_status, ws_control, ws_config, ws_storage;


if(window.webkitRequestAnimationFrame) window.requestAnimationFrame = window.webkitRequestAnimationFrame;

graph.profile =
{
    label: "Profile",
    data: [],
    points: { show: false },
    color: "#28b62c",
    draggable: false
};

graph.live =
{
    label: "Live",
    data: [],
    points: { show: false },
    color: "#e80909",
    draggable: false
};


function updateProfile(id)
{
    selected_profile = id;
    selected_profile_name = profiles[id].name;
    var job_seconds = profiles[id].data.length === 0 ? 0 : parseInt(profiles[id].data[profiles[id].data.length-1][0]);
    var kwh = (3850*job_seconds/3600/1000).toFixed(2);
    var cost =  (kwh*kwh_rate).toFixed(2);
    var job_time = new Date(job_seconds * 1000).toISOString().substr(11, 8);
    $('#sel_prof').html(profiles[id].name);
    $('#sel_prof_eta').html(job_time);
    $('#sel_prof_cost').html(kwh + ' kWh ('+ currency_type +': '+ cost +')');
    graph.profile.data = profiles[id].data;
    graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ] , getOptions());
    populateAimSegments(id);
}

// mirror of the server's segment derivation so segment indices line up
// (rate in deg/hr, hold in seconds)
function deriveSegments(profile)
{
    if (profile.rth && profile.rth.length) {
        return profile.rth.map(function(r){ return {rate: r[0], target: r[1], hold: r[2]*3600}; });
    }
    var pts = (profile.data || []).slice().sort(function(a,b){ return a[0]-b[0]; });
    var segs = [];
    for (var i=1; i<pts.length; i++) {
        var t0 = pts[i-1][0], T0 = pts[i-1][1], t1 = pts[i][0], T1 = pts[i][1];
        var dt = t1 - t0;
        if (dt <= 0) continue;
        if (T1 === T0) {
            // flat run = hold; merged onto the previous segment if same temp
            if (segs.length && segs[segs.length-1].target === T1) { segs[segs.length-1].hold += dt; }
            else segs.push({rate: 0, target: T1, hold: dt});
        } else {
            segs.push({rate: Math.abs(T1-T0)/dt*3600, target: T1, hold: 0});
        }
    }
    return segs;
}

// nominal seconds to reach segment `index`'s target temp from startTemp
// (mirrors Profile.nominal_time_to_segment on the server)
function timeToSegmentTarget(segs, startTemp, index)
{
    var t = 0.0, temp = startTemp;
    for (var i=0; i<segs.length; i++) {
        var ratePerSec = segs[i].rate / 3600.0;
        if (ratePerSec > 0 && segs[i].target !== temp) t += Math.abs(segs[i].target - temp) / ratePerSec;
        if (i === index) return t;
        temp = segs[i].target;
        t += segs[i].hold;
    }
    return t;
}

function formatDuration(seconds)
{
    var s = Math.round(seconds);
    var h = Math.floor(s / 3600);
    var m = Math.round((s - h*3600) / 60);
    if (m === 60) { h += 1; m = 0; }
    return h > 0 ? (h + 'h ' + m + 'm') : (m + 'm');
}

// wall-clock time like "3:45 PM"
function clockTime(date)
{
    return date.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
}

// countdown like "1:23:45" or "12:30"
function hms(seconds)
{
    seconds = Math.max(0, parseInt(seconds) || 0);
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = seconds % 60;
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return h > 0 ? (h + ':' + p(m) + ':' + p(s)) : (m + ':' + p(s));
}

function setStateWord(word, cls)
{
    $('#state').removeClass('running holding waiting error').addClass(cls || '').html(word);
}

function populateAimSegments(id)
{
    var profile = profiles[id];
    var segs = deriveSegments(profile);
    var startTemp = (profile.data && profile.data.length) ? profile.data[0][1] : 0;
    var opts = '';
    for (var i=0; i<segs.length; i++) {
        var eta = formatDuration(timeToSegmentTarget(segs, startTemp, i));
        opts += '<option value="'+i+'">Segment '+(i+1)+' — '+Math.round(segs[i].target)+'°'+temp_scale_display+' ('+eta+')</option>';
    }
    $('#aim_segment').html(opts);
}

function toggleAim()
{
    if ($('#aim_enable').is(':checked')) { $('#aim_fields').slideDown(); }
    else { $('#aim_fields').slideUp(); }
}

function deleteProfile()
{
    var profile = { "type": "profile", "data": "", "name": selected_profile_name };
    var delete_struct = { "cmd": "DELETE", "profile": profile };

    var delete_cmd = JSON.stringify(delete_struct);
    console.log("Delete profile:" + selected_profile_name);

    ws_storage.send(delete_cmd);

    ws_storage.send('GET');
    selected_profile_name = profiles[0].name;

    state="IDLE";
    $('#edit').hide();
    $('#profile_selector').show();
    $('#btn_controls').show();
    $('#status').slideDown();
    $('#profile_table').slideUp();
    $('#e2').val(0);
    graph.profile.points.show = false;
    graph.profile.draggable = false;
    graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ], getOptions());
}


// drive the radial progress ring (circumference of r=52 is 2*pi*52)
function updateProgress(percentage)
{
    var pct = percentage;
    if (isNaN(pct) || pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    var C = 326.726;
    $('#progress_ring').css('stroke-dashoffset', C * (1 - pct / 100));
    $('#progress_pct').html(Math.round(pct) + '%');
}

function updateProfileTable()
{
    var dps = 0;
    var slope = "";
    var color = "";

    var html = '<h3>Schedule Points</h3><div class="table-responsive" style="scroll: none"><table class="table table-striped">';
        html += '<tr><th style="width: 50px">#</th><th>Target Time in ' + time_scale_long+ '</th><th>Target Temperature in °'+temp_scale_display+'</th><th>Slope in &deg;'+temp_scale_display+'/'+time_scale_slope+'</th><th></th></tr>';

    for(var i=0; i<graph.profile.data.length;i++)
    {

        if (i>=1) dps =  ((graph.profile.data[i][1]-graph.profile.data[i-1][1])/(graph.profile.data[i][0]-graph.profile.data[i-1][0]) * 10) / 10;
        if (dps  > 0) { slope = "up";     color="rgba(206, 5, 5, 1)"; } else
        if (dps  < 0) { slope = "down";   color="rgba(23, 108, 204, 1)"; dps *= -1; } else
        if (dps == 0) { slope = "right";  color="grey"; }

        html += '<tr><td><h4>' + (i+1) + '</h4></td>';
        html += '<td><input type="text" class="form-control" id="profiletable-0-'+i+'" value="'+ timeProfileFormatter(graph.profile.data[i][0],true) + '" style="width: 60px" /></td>';
        html += '<td><input type="text" class="form-control" id="profiletable-1-'+i+'" value="'+ graph.profile.data[i][1] + '" style="width: 60px" /></td>';
        html += '<td><div class="input-group"><span class="glyphicon glyphicon-circle-arrow-' + slope + ' input-group-addon ds-trend" style="background: '+color+'"></span><input type="text" class="form-control ds-input" readonly value="' + formatDPS(dps) + '" style="width: 100px" /></div></td>';
        html += '<td>&nbsp;</td></tr>';
    }

    html += '</table></div>';

    $('#profile_table').html(html);

    //Link table to graph
    $(".form-control").change(function(e)
        {
            var id = $(this)[0].id; //e.currentTarget.attributes.id
            var value = parseInt($(this)[0].value);
            var fields = id.split("-");
            var col = parseInt(fields[1]);
            var row = parseInt(fields[2]);

            if (graph.profile.data.length > 0) {
            if (col == 0) {
                graph.profile.data[row][col] = timeProfileFormatter(value,false);
            }
            else {
                graph.profile.data[row][col] = value;
            }

            graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ], getOptions());
            }
            updateProfileTable();

        });
}

function timeProfileFormatter(val, down) {
    var rval = val
    switch(time_scale_profile){
        case "m":
            if (down) {rval = val / 60;} else {rval = val * 60;}
            break;
        case "h":
            if (down) {rval = val / 3600;} else {rval = val * 3600;}
            break;
    }
    return Math.round(rval);
}

function formatDPS(val) {
    var tval = val;
    if (time_scale_slope == "m") {
        tval = val * 60;
    }
    if (time_scale_slope == "h") {
        tval = (val * 60) * 60;
    }
    return Math.round(tval);
}

function hazardTemp(){

    if (temp_scale == "f") {
        return (1500 * 9 / 5) + 32
    }
    else {
        return 1500
    }
}

// x-axis as wall-clock time. graph_start_ms is the clock time at runtime=0
// (set when a run starts); when idle we anchor at "now" so a preview reads
// as if it started now.
function timeTickFormatter(val, axis)
{
    var base = graph_start_ms || Date.now();
    var d = new Date(base + val * 1000);
    var h = d.getHours(), m = d.getMinutes();
    var ampm = h < 12 ? 'AM' : 'PM';
    var h12 = h % 12 || 12;
    // omit ":00" on the hour to keep labels short on narrow screens
    return (m === 0) ? (h12 + ' ' + ampm) : (h12 + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm);
}

// place x-axis ticks on clean clock boundaries (:00/:15/:30/:45, or whole
// hours for longer firings) instead of arbitrary offsets from the start time
function clockTickGenerator(axis)
{
    var base = graph_start_ms || Date.now();
    var span = axis.max - axis.min;                 // seconds visible
    var steps = [900, 1800, 3600, 7200, 10800, 21600, 43200, 86400]; // 15m..24h
    // fewer ticks on a phone so the clock labels don't crowd/overlap
    var want = (window.innerWidth && window.innerWidth < 720) ? 4 : 6;
    var step = steps[steps.length - 1];
    for (var i = 0; i < steps.length; i++) {
        if (steps[i] >= span / want) { step = steps[i]; break; }
    }
    var stepMs = step * 1000;
    // first clock instant >= axis.min, aligned to the step (15-min granularity
    // keeps :00/:15/:30/:45 alignment in any real timezone)
    var firstMs = Math.ceil((base + axis.min * 1000) / stepMs) * stepMs;
    var ticks = [];
    for (var t = firstMs; t <= base + axis.max * 1000; t += stepMs) {
        ticks.push((t - base) / 1000);              // back to runtime seconds
    }
    return ticks;
}

function runTask()
{
    // resume the previous firing: keep the existing red trace and let the
    // server pick up where it stopped (profile + runtime come from the
    // server's resume snapshot, so the dropdown selection is ignored)
    if ($('#resume_enable').is(':checked')) {
        ws_control.send(JSON.stringify({"cmd": "RUN", "resume": true}));
        return;
    }

    var cmd =
    {
        "cmd": "RUN",
        "profile": profiles[selected_profile]
    }

    // aimed start: reach the chosen segment's temperature at the given time
    if ($('#aim_enable').is(':checked')) {
        var tval = $('#aim_time').val();
        if (tval) {
            cmd.aim_segment = parseInt($('#aim_segment').val());
            cmd.aim_time = Math.floor(new Date(tval).getTime() / 1000);
        }
    }

    graph.live.data = [];
    graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ] , getOptions());

    ws_control.send(JSON.stringify(cmd));

}

function toggleResume()
{
    // resuming uses the previous firing as-is, so hide the aim options
    if ($('#resume_enable').is(':checked')) {
        $('#aim_enable').prop('checked', false);
        $('#aim_fields').hide();
        $('#aim_row').hide();
    } else {
        $('#aim_row').show();
    }
}

function runTaskSimulation()
{
    var cmd =
    {
        "cmd": "SIMULATE",
        "profile": profiles[selected_profile]
    }

    graph.live.data = [];
    graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ] , getOptions());

    ws_control.send(JSON.stringify(cmd));

}


function abortTask()
{
    var cmd = {"cmd": "STOP"};
    ws_control.send(JSON.stringify(cmd));
}

// generic confirmation modal: runs cb only if the user confirms
var _confirm_cb = null;
function confirmAction(title, body, okLabel, okClass, cb)
{
    $('#confirmModalTitle').text(title);
    $('#confirmModalBody').text(body);
    $('#confirmModalOk').text(okLabel)
        .removeClass('btn-danger btn-warning btn-success btn-default')
        .addClass(okClass);
    _confirm_cb = cb;
    $('#confirmModal').modal('show');
}

function confirmStop()
{
    confirmAction('Stop the firing?',
        'This aborts the current firing immediately and the kiln stops heating. This cannot be undone.',
        'Stop firing', 'btn-danger', abortTask);
}

function confirmAdvance()
{
    confirmAction('Skip to the next segment?',
        'This ends the current segment now and starts the next one. This cannot be undone.',
        'Advance', 'btn-warning', advanceSegment);
}

function toggleHold()
{
    // manual_hold is kept in sync from the status feed; send the opposite
    var cmd = manual_hold ? "RESUME" : "HOLD";
    ws_control.send(JSON.stringify({"cmd": cmd}));
}

function advanceSegment()
{
    ws_control.send(JSON.stringify({"cmd": "ADVANCE"}));
}

function holdLabel(seconds)
{
    if (seconds <= 0) return '-';
    return seconds >= 3600 ? (seconds/3600).toFixed(1)+'h' : Math.round(seconds/60)+'m';
}

function renderSegmentEditor(segments, active)
{
    var html = '<button id="nav_edit_segments" type="button" class="btn btn-default btn-sm" onclick="toggleSegmentsEdit()" style="float:right; margin-top:4px"><span class="glyphicon glyphicon-edit"></span> Edit</button>';
    html += '<h4>Segments <small>(click Edit, then click a segment on the graph to change it)</small></h4>';
    html += '<div class="table-responsive"><table class="table table-condensed" style="margin-bottom:0">';
    html += '<tr><th style="width:40px">#</th><th>Rate &deg;'+temp_scale_display+'/hr</th><th>Target &deg;'+temp_scale_display+'</th><th>Hold (min)</th></tr>';
    for (var i=0; i<segments.length; i++)
    {
        var s = segments[i];
        var cls = (i === active) ? ' class="info"' : '';
        html += '<tr'+cls+'><td>'+(i+1)+'</td>';
        html += '<td>'+Math.round(s.rate)+'</td>';
        html += '<td><input type="number" class="form-control input-sm seg-target" data-seg="'+i+'" value="'+Math.round(s.target)+'" style="width:90px" /></td>';
        html += '<td><input type="number" min="0" class="form-control input-sm seg-hold" data-seg="'+i+'" value="'+Math.round(s.hold/60)+'" style="width:90px" /></td></tr>';
    }
    html += '</table></div>';
    $('#segment_table').html(html);
    applySegmentsEditable();  // start locked (read-only) unless edit mode is on

    $('.seg-target').change(function()
    {
        var idx = parseInt($(this).attr('data-seg'));
        var val = parseFloat($(this).val());
        if (!isNaN(val)) {
            ws_control.send(JSON.stringify({"cmd": "SET_SEGMENT_TARGET", "segment": idx, "target": val}));
        }
    });

    $('.seg-hold').change(function()
    {
        var idx = parseInt($(this).attr('data-seg'));
        var mins = parseFloat($(this).val());
        if (!isNaN(mins) && mins >= 0) {
            // backend works in seconds
            ws_control.send(JSON.stringify({"cmd": "SET_SEGMENT_HOLD", "segment": idx, "hold": mins * 60}));
        }
    });
}

function applySegmentsEditable()
{
    // All fields locked by default. Only the segment the user explicitly
    // selected (by clicking it on the graph) while armed is editable, so a
    // stray edit can't change a live firing.
    $('.seg-target, .seg-hold').prop('disabled', true);
    $('#segment_table tr').removeClass('warning');
    if (segments_armed && selected_segment >= 0) {
        $('.seg-target[data-seg="'+selected_segment+'"], .seg-hold[data-seg="'+selected_segment+'"]').prop('disabled', false);
        $('#segment_table tr').eq(selected_segment + 1).addClass('warning');
    }
    if (segments_armed) {
        $('#nav_edit_segments').removeClass('btn-default').addClass('btn-warning')
            .html('<span class="glyphicon glyphicon-ok"></span> Done');
    } else {
        $('#nav_edit_segments').removeClass('btn-warning').addClass('btn-default')
            .html('<span class="glyphicon glyphicon-edit"></span> Edit');
    }
}

function toggleSegmentsEdit()
{
    segments_armed = !segments_armed;
    selected_segment = -1;  // arming selects nothing; disarming clears
    applySegmentsEditable();
    if (segments_armed) {
        $.bootstrapGrowl("<span class=\"glyphicon glyphicon-hand-up\"></span> Click a segment on the graph to edit it", {
            ele: 'body', type: 'info', offset: {from: 'top', amount: 250},
            align: 'center', width: 385, delay: 4000, allow_dismiss: true });
    }
}

function selectSegment(seg)
{
    if (seg < 0 || seg >= segment_editor_count) return;
    selected_segment = seg;
    applySegmentsEditable();
    $('.seg-target[data-seg="'+seg+'"]').focus();
}

// nominal end time (seconds) of each segment, used to map a graph click to
// the segment whose span contains that time
function segmentEndTimes(segments, startTemp)
{
    var t = 0.0, temp = startTemp, ends = [];
    for (var i=0; i<segments.length; i++) {
        var s = segments[i], ratePerSec = s.rate / 3600.0;
        if (temp !== s.target) {
            if (ratePerSec > 0) t += Math.abs(s.target - temp) / ratePerSec;
            temp = s.target;
        }
        if (s.hold > 0) t += s.hold;
        ends.push(t);
    }
    return ends;
}

function segmentAtTime(x)
{
    for (var i=0; i<segment_end_times.length; i++) {
        if (x <= segment_end_times[i]) return i;
    }
    return segment_end_times.length - 1;  // past the end -> last segment
}

// Mirror of the server's segments_to_points: build the ideal time/temp
// curve from the (possibly edited) segments so the green line stays in sync.
function segmentsToPoints(segments, startTemp)
{
    var t = 0.0;
    var temp = startTemp;
    var pts = [[0, temp]];
    for (var i=0; i<segments.length; i++)
    {
        var s = segments[i];
        var ratePerSec = s.rate / 3600.0;
        if (temp !== s.target) {
            if (ratePerSec > 0) t += Math.abs(s.target - temp) / ratePerSec;
            temp = s.target;
            pts.push([Math.round(t), temp]);
        }
        if (s.hold > 0) {
            t += s.hold;
            pts.push([Math.round(t), temp]);
        }
    }
    return pts;
}

function manageSegmentEditor(x)
{
    if (!x.segments) return;
    var sig = JSON.stringify(x.segments.map(function(s){ return [s.target, s.hold]; }));
    // keep the click->segment time map current with any edits
    segment_end_times = segmentEndTimes(x.segments, x.start_temp);
    // (re)build the table only when the segment set changes (new run);
    // otherwise just move the active-row highlight so we never clobber a
    // field being edited
    if (x.segments.length !== segment_editor_count) {
        segment_editor_count = x.segments.length;
        segment_signature = sig;  // baseline; keep the as-loaded green curve
        segments_armed = false;     // every new run starts locked (safe)
        selected_segment = -1;
        renderSegmentEditor(x.segments, x.segment);
    } else {
        $('#segment_table tr').removeClass('info');
        if (x.segment !== null && x.segment !== undefined) {
            $('#segment_table tr').eq(x.segment + 1).addClass('info');
        }
        // a target/hold was edited -> rebuild the ideal (green) curve so it
        // reflects the change. The per-tick replot below renders it.
        if (sig !== segment_signature) {
            segment_signature = sig;
            graph.profile.data = segmentsToPoints(x.segments, x.start_temp);
        }
    }
}

function updateHoldButton()
{
    if (manual_hold) {
        // blue (not green) so Resume isn't confused with the green Start button
        $('#nav_hold').removeClass('btn-warning').addClass('btn-info')
            .html('<span class="glyphicon glyphicon-play"></span> Resume');
    } else {
        $('#nav_hold').removeClass('btn-info').addClass('btn-warning')
            .html('<span class="glyphicon glyphicon-pause"></span> Hold');
    }
}

var controller_name = "";

// show the controller's human name in the header; keep the edit field in sync
function setControllerName(name)
{
    controller_name = name;
    $('#controller_name').text(name);
    document.title = name + " — Kiln Controller";
}

// switch the header into inline-edit mode
function editControllerName()
{
    $('#controller_name_input').val(controller_name);
    $('#controller_name').hide();
    $('#controller_name_edit').show();
    $('#controller_name_input').focus().select();
}

function cancelControllerName()
{
    $('#controller_name_edit').hide();
    $('#controller_name').show();
}

// persist the new name via the REST /api endpoint, then update the header
function saveControllerName()
{
    var name = $.trim($('#controller_name_input').val());
    if (name === "") { return; }
    $.ajax({
        url: "/api",
        type: "POST",
        contentType: "application/json",
        data: JSON.stringify({"cmd": "set_controller_name", "name": name}),
        success: function(resp) {
            if (resp && resp.success) {
                setControllerName(resp.name);
                cancelControllerName();
            } else {
                $.bootstrapGrowl((resp && resp.error) || "Could not rename controller", {type: "danger"});
            }
        },
        error: function() {
            $.bootstrapGrowl("Could not reach the controller to rename it", {type: "danger"});
        }
    });
}

function clearProfile()
{
    if (state == "RUNNING") return;

    // tell the server to drop the recorded run trace so a reconnecting
    // browser doesn't reload it (the selected profile is kept)
    ws_control.send(JSON.stringify({"cmd": "CLEAR"}));

    // clear only the run-time (live) trace; leave the selected profile,
    // its green curve, and the dropdown selection in place
    graph.live.data = [];
    graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ], getOptions());

    run_log = [];
    $('#target_temp').html('---');
    updateProgress(0);
}

function enterNewMode()
{
    state="EDIT"
    $('#status').slideUp();
    $('#edit').show();
    $('#profile_selector').hide();
    $('#btn_controls').hide();
    $('#form_profile_name').attr('value', '');
    $('#form_profile_name').attr('placeholder', 'Please enter a name');
    graph.profile.points.show = true;
    graph.profile.draggable = true;
    graph.profile.data = [];
    graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ], getOptions());
    updateProfileTable();
}

function enterEditMode()
{
    state="EDIT"
    $('#status').slideUp();
    $('#edit').show();
    $('#profile_selector').hide();
    $('#btn_controls').hide();
    console.log(profiles);
    $('#form_profile_name').val(profiles[selected_profile].name);
    graph.profile.points.show = true;
    graph.profile.draggable = true;
    graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ], getOptions());
    updateProfileTable();
}

function leaveEditMode()
{
    selected_profile_name = $('#form_profile_name').val();
    ws_storage.send('GET');
    state="IDLE";
    $('#edit').hide();
    $('#profile_selector').show();
    $('#btn_controls').show();
    $('#status').slideDown();
    $('#profile_table').slideUp();
    graph.profile.points.show = false;
    graph.profile.draggable = false;
    graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ], getOptions());
}

function newPoint()
{
    if(graph.profile.data.length > 0)
    {
        var pointx = parseInt(graph.profile.data[graph.profile.data.length-1][0])+15;
    }
    else
    {
        var pointx = 0;
    }
    graph.profile.data.push([pointx, Math.floor((Math.random()*230)+25)]);
    graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ], getOptions());
    updateProfileTable();
}

function delPoint()
{
    graph.profile.data.splice(-1,1)
    graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ], getOptions());
    updateProfileTable();
}

function toggleTable()
{
    if($('#profile_table').css('display') == 'none')
    {
        $('#profile_table').slideDown();
    }
    else
    {
        $('#profile_table').slideUp();
    }
}

function saveProfile()
{
    name = $('#form_profile_name').val();
    var rawdata = graph.plot.getData()[0].data
    var data = [];
    var last = -1;

    for(var i=0; i<rawdata.length;i++)
    {
        if(rawdata[i][0] > last)
        {
          data.push([rawdata[i][0], rawdata[i][1]]);
        }
        else
        {
          $.bootstrapGrowl("<span class=\"glyphicon glyphicon-exclamation-sign\"></span> <b>ERROR 88:</b><br/>An oven is not a time-machine", {
            ele: 'body', // which element to append to
            type: 'alert', // (null, 'info', 'error', 'success')
            offset: {from: 'top', amount: 250}, // 'top', or 'bottom'
            align: 'center', // ('left', 'right', or 'center')
            width: 385, // (integer, or 'auto')
            delay: 5000,
            allow_dismiss: true,
            stackup_spacing: 10 // spacing between consecutively stacked growls.
          });

          return false;
        }

        last = rawdata[i][0];
    }

    var profile = { "type": "profile", "data": data, "name": name }
    var put = { "cmd": "PUT", "profile": profile }

    var put_cmd = JSON.stringify(put);

    ws_storage.send(put_cmd);

    leaveEditMode();
}

function get_tick_size() {
//switch(time_scale_profile){
//  case "s":
//    return 1;
//  case "m":
//    return 60;
//  case "h":
//    return 3600;
//  }
return 3600;
}

function getOptions()
{

  var options =
  {

    series:
    {
        lines:
        {
            show: true
        },

        points:
        {
            show: true,
            radius: 0,
            symbol: "circle"
        },

        shadowSize: 0

    },

	xaxis:
    {
      min: 0,
      tickColor: 'rgba(216, 211, 197, 0.2)',
      tickFormatter: timeTickFormatter,
      ticks: clockTickGenerator,
      font:
      {
        size: 12,
        lineHeight: 12,        weight: "normal",
        family: "courier",
        variant: "small-caps",
        color: "rgba(0,0,0, 0.6)"
      }
	},

	yaxis:
    {
      min: 0,
      tickDecimals: 0,
      draggable: false,
      tickColor: 'rgba(216, 211, 197, 0.2)',
      font:
      {
        size: 12,
        lineHeight: 12,
        weight: "normal",
        family: "courier",
        variant: "small-caps",
        color: "rgba(0,0,0, 0.6)"
      }
	},

	grid:
    {
	  color: 'rgba(216, 211, 197, 0.55)',
      borderWidth: 1,
      labelMargin: 10,
      mouseActiveRadius: 50,
      clickable: true
	},

    legend:
    {
      show: false
    }
  }

  return options;

}

function saveLog()
{
    exportToCsv('kiln.csv', run_log);
}

function exportToCsv(filename, rows) {
    var processRow = function (row) {
        var finalVal = '';
        for (var j = 0; j < row.length; j++) {
            var innerValue = row[j] === null ? '' : row[j].toString();
            if (row[j] instanceof Date) {
                innerValue = row[j].toLocaleString();
            };
            var result = innerValue.replace(/"/g, '""');
            if (result.search(/("|,|\n)/g) >= 0)
                result = '"' + result + '"';
            if (j > 0)
                finalVal += ',';
            finalVal += result;
        }
        return finalVal + '\n';
    };

    var csvFile = '';
    for (var i = 0; i < rows.length; i++) {
        csvFile += processRow(rows[i]);
    }

    var blob = new Blob([csvFile], { type: 'text/csv;charset=utf-8;' });
    if (navigator.msSaveBlob) { // IE 10+
        navigator.msSaveBlob(blob, filename);
    } else {
        var link = document.createElement("a");
        if (link.download !== undefined) { // feature detection
            // Browsers that support HTML5 download attribute
            var url = URL.createObjectURL(blob);
            link.setAttribute("href", url);
            link.setAttribute("download", filename);
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }
    }
}



$(document).ready(function()
{

    if(!("WebSocket" in window))
    {
        $('#chatLog, input, button, #examples').fadeOut("fast");
        $('<p>Oh no, you need a browser that supports WebSockets. How about <a href="http://www.google.com/chrome">Google Chrome</a>?</p>').appendTo('#container');
    }
    else
    {

        // Connection state / reconnect handling ////////////
        //
        // All four sockets drop together when the service restarts. Show a
        // persistent "disconnected" banner (driven by the status socket, the
        // live heartbeat) and keep recreating any closed socket every few
        // seconds until the service comes back.

        var _reconnect_timer = null;

        function setConnected(connected)
        {
            if (connected) { $('#conn_banner').hide(); }
            else           { $('#conn_banner').show(); }
        }

        function scheduleReconnect()
        {
            setConnected(false);
            if (_reconnect_timer) { return; }   // a retry is already pending
            _reconnect_timer = setTimeout(function()
            {
                _reconnect_timer = null;
                // readyState: 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED
                if (!ws_status  || ws_status.readyState  > 1) { setupStatusSocket();  }
                if (!ws_config  || ws_config.readyState  > 1) { setupConfigSocket();  }
                if (!ws_control || ws_control.readyState > 1) { setupControlSocket(); }
                if (!ws_storage || ws_storage.readyState > 1) { setupStorageSocket(); }
            }, 2000);
        }

        // Status Socket ////////////////////////////////

        function setupStatusSocket()
        {
            ws_status = new WebSocket(host + "/status");

            ws_status.onopen = function()
            {
                console.log("Status Socket has been opened");
                setConnected(true);
            };

            ws_status.onerror = function()
            {
                try { ws_status.close(); } catch (err) {}
            };

            ws_status.onclose = function()
            {
                console.log("Status Socket closed - will retry");
                scheduleReconnect();
            };

            ws_status.onmessage = function(e)
        {
            //console.log("received status data")
            //console.log(e.data);

            x = JSON.parse(e.data);
            if (x.type == "backlog")
            {
                if (x.profile)
                {
                    selected_profile_name = x.profile.name;
                    $.each(profiles,  function(i,v) {
                        if(v.name == x.profile.name) {
                            updateProfile(i);
                            $('#e2').val(i);
                        }
                    });
                }

                $.each(x.log, function(i,v) {
                    graph.live.data.push([v.runtime, v.temperature]);
                });
                graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ] , getOptions());
            }

            if(state!="EDIT")
            {
                state = x.state;

                if (state!=state_last)
                {
                    if (state == 'RUNNING' && (state_last == 'IDLE' || state_last == 'WAITING')) {
                        run_log = [['time','target','temp','heat','pid.error','pid.errorDelta','pid.p','pid.i','pid.d','pid.kp','pdi.ki','pid.kd']]
                    }
                    if(state_last == "RUNNING")
                    {
                        if (state.includes("ERROR")) {
                            $('#target_temp').html('---');
                            updateProgress(0);
                            $.bootstrapGrowl("<span class=\"glyphicon glyphicon-exclamation-sign\"></span> <b>" + state + "</b>", {
                            ele: 'body', // which element to append to
                            type: 'error', // (null, 'info', 'error', 'success')
                            offset: {from: 'top', amount: 250}, // 'top', or 'bottom'
                            align: 'center', // ('left', 'right', or 'center')
                            width: 385, // (integer, or 'auto')
                            delay: 0,
                            allow_dismiss: true,
                            stackup_spacing: 10 // spacing between consecutively stacked growls.
                            });
                        }
                        else {
                            // normal completion or Stop: just reset the readouts,
                            // no popup (only errors notify)
                            $('#target_temp').html('---');
                            updateProgress(0);
                        }
                    }
                }

                if(state=="RUNNING")
                {
                    run_log.push([
                        x.pidstats.time,
                        x.target,
                        x.temperature,
                        x.heat,
                        x.pidstats.err,
                        x.pidstats.errDelta,
                        x.pidstats.p,
                        x.pidstats.i,
                        x.pidstats.d,
                        x.pidstats.kp,
                        x.pidstats.ki,
                        x.pidstats.kd
                    ]);

                    $("#nav_start").hide();
                    $("#nav_stop").show();
                    $("#nav_hold").show();
                    $("#nav_advance").show();
                    $("#nav_clear").hide();

                    manual_hold = (x.manual_hold === true);
                    updateHoldButton();

                    $("#segment_table").show();
                    manageSegmentEditor(x);

                    if (graph_start_ms === null) graph_start_ms = Date.now() - x.runtime * 1000;
                    graph.live.data.push([x.runtime, x.temperature]);
                    graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ] , getOptions());

                    setStateWord(manual_hold ? "HOLDING" : "RUNNING", manual_hold ? "holding" : "running");
                    updateProgress(parseFloat(x.runtime) / parseFloat(x.totaltime) * 100);

                    // completion clock = run start + total (sim) duration. Anchored
                    // to graph_start_ms (the wall-clock at runtime=0) so it reads as a
                    // fixed wall-clock time and doesn't count down when the sim runs fast.
                    $('#eta_complete').html('done ' + clockTime(new Date(graph_start_ms + x.totaltime * 1000)));

                    // current segment, with both the ramp-reaches-temp ETA and
                    // the hold-ends ETA as fixed clock times
                    if (x.segments && x.segment !== null && x.segment < x.segments.length
                        && x.segment_remaining !== null && x.segment_remaining !== undefined) {
                        var seg = x.segments[x.segment];
                        $('#seg_info').html('Seg ' + (x.segment + 1) + ' &middot; ' + Math.round(seg.target) + '&deg;' + temp_scale_display);
                        // during a ramp, segment_remaining = (time to target) + full hold
                        var rampRem = (x.phase === 'RAMP') ? Math.max(0, x.segment_remaining - seg.hold) : 0;
                        var rampEta = clockTime(new Date(graph_start_ms + (x.runtime + rampRem) * 1000));
                        var holdEta = clockTime(new Date(graph_start_ms + (x.runtime + x.segment_remaining) * 1000));
                        var txt;
                        if (x.phase === 'RAMP') {
                            txt = 'eta ' + rampEta;
                            if (seg.hold > 0) txt += ', hold until ' + holdEta;
                        } else {
                            // at temperature, soaking
                            txt = (x.segment_remaining > 0.5) ? 'hold until ' + holdEta : 'complete';
                        }
                        $('#seg_eta').html(txt);
                    } else { $('#seg_info').html(''); $('#seg_eta').html(''); }

                    $('#target_temp').html(parseInt(x.target));
                  


                }
                else if (state == "WAITING")
                {
                    // aimed start: waiting (idle, no heat) for the start time
                    $("#nav_start").hide();
                    $("#nav_stop").show();   // Stop cancels the scheduled start
                    $("#nav_hold").hide();
                    $("#nav_advance").hide();
                    $("#nav_clear").hide();
                    $("#segment_table").hide();
                    setStateWord("WAITING", "waiting");
                    updateProgress(0);
                    $('#progress_pct').html(hms(x.wait_remaining));
                    $('#eta_complete').html('until start');
                    $('#seg_info').html('');
                    $('#seg_eta').html('');
                    $('#target_temp').html('---');
                }
                else
                {
                    $("#nav_start").show();
                    $("#nav_stop").hide();
                    $("#nav_hold").hide();
                    $("#nav_advance").hide();
                    $("#nav_clear").show();
                    $("#segment_table").hide();
                    segment_editor_count = -1;  // rebuild fresh on the next run
                    segments_armed = false;     // re-lock for the next run
                    selected_segment = -1;
                    graph_start_ms = null;      // idle preview anchors at "now"
                    var isErr = (typeof state === 'string' && state.indexOf('ERROR') !== -1);
                    setStateWord(state, isErr ? 'error' : '');
                    updateProgress(0);
                    $('#progress_pct').html('&mdash;');
                    $('#eta_complete').html('');
                    $('#seg_info').html('');
                    $('#seg_eta').html('');
                }

                if (x.watcher_alarm) { $('#watcher_alarm').show(); } else { $('#watcher_alarm').hide(); }

                // offer resume of a stopped/failed firing on the Start dialog
                if (x.resume_available) {
                    $('#resume_row').show();
                    $('#resume_label').text('Resume previous firing — ' + x.resume_profile + ' at ' + hms(x.resume_runtime));
                } else {
                    $('#resume_row').hide();
                    $('#resume_enable').prop('checked', false);
                }

                $('#act_temp').html(parseInt(x.temperature));
                // heating indicator: glow the temp card + show the pill
                if (x.heat > 0 || (x.pidstats && x.pidstats.out > 0.02)) {
                    $('#heat').addClass('on'); $('#temp_card').addClass('heating');
                } else {
                    $('#heat').removeClass('on'); $('#temp_card').removeClass('heating');
                }

                state_last = state;

            }
        };
        }   // end setupStatusSocket

        // Config Socket /////////////////////////////////

        function setupConfigSocket()
        {
            ws_config = new WebSocket(host + "/config");

            ws_config.onclose = function() { scheduleReconnect(); };

            ws_config.onopen = function()
            {
                ws_config.send('GET');
            };

            ws_config.onmessage = function(e)
        {
            console.log (e.data);
            x = JSON.parse(e.data);
            temp_scale = x.temp_scale;
            time_scale_slope = x.time_scale_slope;
            time_scale_profile = x.time_scale_profile;
            kwh_rate = x.kwh_rate;
            currency_type = x.currency_type;

            if (x.controller_name) { setControllerName(x.controller_name); }

            if (temp_scale == "c") {temp_scale_display = "C";} else {temp_scale_display = "F";}

            // if the history view rendered before the scale arrived (e.g. a cold
            // #history deep-link), re-render it now with the right unit
            if ($("#history_view").is(":visible") && histList) {
                renderHistList(histDetail ? histDetail.id : null);
                if (histDetail) renderHistDetail(histDetail);
            }

            $('#act_temp_scale').html('º'+temp_scale_display);
            $('#target_temp_scale').html('º'+temp_scale_display);

            switch(time_scale_profile){
                case "s":
                    time_scale_long = "Seconds";
                    break;
                case "m":
                    time_scale_long = "Minutes";
                    break;
                case "h":
                    time_scale_long = "Hours";
                    break;
            }

        }
        }   // end setupConfigSocket

        // Control Socket ////////////////////////////////

        function setupControlSocket()
        {
            ws_control = new WebSocket(host + "/control");

            ws_control.onclose = function() { scheduleReconnect(); };

            ws_control.onopen = function()
            {

            };

            ws_control.onmessage = function(e)
        {
            //Data from Simulation
            console.log ("control socket has been opened")
            console.log (e.data);
            x = JSON.parse(e.data);
            graph.live.data.push([x.runtime, x.temperature]);
            graph.plot = $.plot("#graph_container", [ graph.profile, graph.live ] , getOptions());

        }
        }   // end setupControlSocket

        // Storage Socket ///////////////////////////////

        function setupStorageSocket()
        {
            ws_storage = new WebSocket(host + "/storage");

            ws_storage.onclose = function() { scheduleReconnect(); };

            ws_storage.onopen = function()
            {
                ws_storage.send('GET');
            };

            ws_storage.onmessage = function(e)
        {
            message = JSON.parse(e.data);

            if(message.resp)
            {
                if(message.resp == "FAIL")
                {
                    if (confirm('Overwrite?'))
                    {
                        message.force=true;
                        console.log("Sending: " + JSON.stringify(message));
                        ws_storage.send(JSON.stringify(message));
                    }
                    else
                    {
                        //do nothing
                    }
                }

                return;
            }

            //the message is an array of profiles
            //FIXME: this should be better, maybe a {"profiles": ...} container?
            profiles = message;
            //delete old options in select
            $('#e2').find('option').remove().end();
            // check if current selected value is a valid profile name
            // if not, update with first available profile name
            var valid_profile_names = profiles.map(function(a) {return a.name;});
            if (
              valid_profile_names.length > 0 &&
              $.inArray(selected_profile_name, valid_profile_names) === -1
            ) {
              selected_profile = 0;
              selected_profile_name = valid_profile_names[0];
            }

            // fill select with new options from websocket
            for (var i=0; i<profiles.length; i++)
            {
                var profile = profiles[i];
                //console.log(profile.name);
                $('#e2').append('<option value="'+i+'">'+profile.name+'</option>');

                if (profile.name == selected_profile_name)
                {
                    selected_profile = i;
                    $('#e2').val(i);
                    updateProfile(i);
                }
            }
        };
        }   // end setupStorageSocket

        // Open all four sockets now. Each recreates itself (via
        // scheduleReconnect) if it drops, so a service restart is recovered
        // automatically and the disconnected banner clears on reconnect.
        setupStatusSocket();
        setupConfigSocket();
        setupControlSocket();
        setupStorageSocket();


        // native <select> (no select2): on iOS it uses the native picker
        // instead of popping the keyboard, and styles cleanly
        $("#e2").on("change", function()
        {
            updateProfile($(this).val());
        });

        // confirmation modal: run the stashed callback when OK is clicked
        $("#confirmModalOk").on("click", function()
        {
            var cb = _confirm_cb;
            _confirm_cb = null;
            if (cb) cb();
        });

        // click a segment on the graph to unlock just that one for editing
        // (only while a run is active and editing has been armed via Edit)
        $("#graph_container").bind("plotclick", function(event, pos, item)
        {
            if (!segments_armed || state != "RUNNING") return;
            if (pos == null || pos.x == null) return;
            var seg = segmentAtTime(pos.x);
            if (seg >= 0) selectSegment(seg);
        });

    }
});


/* =======================================================================
   Firing history (Phase 5)
   Lists past firings from /api/firings and shows a detail view: a
   planned-vs-actual canvas graph, an event timeline linked to the graph,
   and read-only firing notes. Ported from the design prototype.
   ======================================================================= */
var histList = null;     // list summaries
var histDetail = null;   // currently loaded full record
var histCurve = null;    // {act, plan, events, bands, xmax, ymax}
var histSel = null;      // selected event index (links list <-> graph)
var histPins = [];        // {x, idx} graph pin hit-targets

function histTU(){ return "°" + (typeof temp_scale_display !== "undefined" ? temp_scale_display : "F"); }
function histEsc(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function histFmtDur(sec){
  sec=Math.max(0,Math.round(sec)); var h=Math.floor(sec/3600), m=Math.round((sec%3600)/60);
  return h>=1 ? (h+"h "+(m<10?"0":"")+m+"m") : (m+"m");
}
function histFmtClock(sec){ var h=Math.floor(sec/3600), m=Math.round((sec%3600)/60); return h+":"+(m<10?"0":"")+m; }
function histFmtDate(iso){
  if(!iso) return "—";
  var d=new Date(String(iso).replace("Z","")); if(isNaN(d)) return iso;
  return d.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"})+" · "+
         d.toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"});
}

var HIST_EV = {
  started:{c:"var(--accent)",i:"▶",t:function(e){return ["Firing started", e.detail&&e.detail.fragments>1?("reassembled from "+e.detail.fragments+" log fragments"):(e.detail&&e.detail.profile||"")];}},
  completed:{c:"var(--accent)",i:"✓",t:function(){return ["Completed",""];}},
  aborted:{c:"#6b7280",i:"■",t:function(){return ["Stopped",""];}},
  interrupted:{c:"var(--warn)",i:"!",t:function(){return ["Interrupted",""];}},
  error:{c:"var(--danger)",i:"✕",t:function(){return ["Error",""];}},
  hold:{c:"var(--warn)",i:"❚❚",t:function(e){return ["Hold engaged", e.detail&&e.detail.setpoint?("setpoint "+Math.round(e.detail.setpoint)+histTU()):""];}},
  hold_release:{c:"var(--warn)",i:"▷",t:function(){return ["Hold released",""];}},
  advance:{c:"var(--info)",i:"»",t:function(e){return ["Advanced segment", e.detail?("segment "+e.detail.from_segment+" → "+e.detail.to_segment):""];}},
  segment_target_edit:{c:"var(--info)",i:"✎",t:function(e){return ["Target edited", e.detail?("seg "+e.detail.segment+": "+Math.round(e.detail.old)+" → "+Math.round(e.detail.new)+histTU()):""];}},
  segment_hold_edit:{c:"var(--info)",i:"✎",t:function(e){return ["Hold edited", e.detail?("seg "+e.detail.segment+": "+Math.round(e.detail.new/60)+" min"):""];}},
  segment_transition:{c:"#9aa3b2",i:"·",t:function(e){return ["Segment "+(e.detail?e.detail.segment:""), e.detail?e.detail.phase:""];}},
  power_interruption:{c:"var(--danger)",i:"⚡",t:function(){return ["Power interrupted",""];}},
  resumed:{c:"var(--info)",i:"↻",t:function(e){return ["Resumed", e.detail&&e.detail.gap_s?("after "+histFmtDur(e.detail.gap_s)):(e.detail&&e.detail.from_status?("from "+e.detail.from_status):"")];}}
};

function toggleHistory(){ if($("#history_view").is(":visible")) showLive(); else showHistory(); }
function showHistory(){ $("#live_view").hide(); $("#history_view").show().removeClass("detail-open"); loadFiringList();
  $("#nav_history").html('<span class="glyphicon glyphicon-chevron-left"></span> Live dashboard');
  if(window.history&&history.replaceState) history.replaceState(null,"","#history"); }
function showLive(){ $("#history_view").hide(); $("#live_view").show(); $(window).trigger("resize");
  $("#nav_history").html('<span class="glyphicon glyphicon-time"></span> History');
  if(window.history&&history.replaceState) history.replaceState(null,"",location.pathname+location.search); }
function histBackToList(){ $("#history_view").removeClass("detail-open"); }

function loadFiringList(){
  $("#hist_list").html('<div class="hist-empty">Loading…</div>'); $("#hist_main").html("");
  $.getJSON("/api/firings").done(function(list){
    histList = list || [];
    if(!histList.length){ $("#hist_list").html(""); $("#hist_main").html('<div class="hist-empty">No firings recorded yet.</div>'); return; }
    $("#history_view").removeClass("detail-open");
    renderHistList(null);
    // desktop shows both panes, so preload the newest firing; on mobile we stay
    // on the list until the user taps one (master-detail)
    if(window.innerWidth>900) loadFiring(histList[0].id); else $("#hist_main").html("");
  }).fail(function(){ $("#hist_list").html('<div class="hist-empty">Could not load firing history.</div>'); });
}

function renderHistList(selId){
  var html="";
  histList.forEach(function(f){
    var s=f.summary||{};
    html += '<button type="button" class="firing-card'+(f.id===selId?" sel":"")+'" onclick="loadFiring(\''+f.id+'\')">'+
      '<div class="fc-top"><span class="fc-date tnum">'+histFmtDate(s.started_at)+'</span>'+
      '<span class="pill '+(s.status||"")+'">'+(s.status||"")+'</span></div>'+
      '<div class="fc-name">'+histEsc(f.profile_name||"—")+'</div>'+
      '<div class="fc-meta tnum"><span><b>'+Math.round(s.max_temp||0)+'</b>'+histTU()+'</span>'+
      '<span><b>'+histFmtDur(s.duration_s||0)+'</b></span></div></button>';
  });
  $("#hist_list").html(html);
}

function loadFiring(id){
  $("#history_view").addClass("detail-open");   // mobile: switch to the detail screen
  renderHistList(id);
  $("#hist_main").html('<div class="hist-empty">Loading firing…</div>');
  $.getJSON("/api/firings/"+encodeURIComponent(id)+"?resolution=800").done(function(d){
    histDetail=d; histSel=null; renderHistDetail(d);
  }).fail(function(){ $("#hist_main").html('<div class="hist-empty">Could not load this firing.</div>'); });
}

function histStat(label,val,unit,accent){
  return '<div class="stat'+(accent?" accent":"")+'"><div class="s-label">'+label+'</div>'+
    '<div class="s-val">'+val+(unit?'<span class="u">'+unit+'</span>':'')+'</div></div>';
}

function renderHistDetail(d){
  var s=d.summary||{};
  var peak = s.peak_target!=null?Math.round(s.peak_target):"—";
  var html =
    '<button type="button" class="hist-back" onclick="histBackToList()"><span class="glyphicon glyphicon-chevron-left"></span> All firings</button>'+
    '<div class="detail-head"><div><h1 class="dh-title">'+histEsc(d.profile.name)+'</h1>'+
      '<div class="dh-sub tnum"><span>'+histFmtDate(s.started_at)+'</span>'+
      (d.imported?'<span class="tag-imported">imported from log</span>':'')+'</div></div>'+
      '<div class="dh-right"><span class="pill '+(s.status||"")+'">'+(s.status||"")+'</span></div></div>'+
    '<div class="stats tnum">'+
      histStat("Max temp", Math.round(s.max_temp||0), histTU(), true)+
      histStat("Peak target", peak, histTU())+
      histStat("Duration", histFmtDur(s.duration_s||0), "")+
    '</div>'+
    '<div class="hist-card"><div class="card-hd"><h3>Planned vs. actual</h3>'+
      '<div class="legend"><span class="lg"><span class="swatch" style="background:var(--heat)"></span>Actual</span>'+
      '<span class="lg"><span class="swatch dash"></span>Planned</span>'+
      '<span class="lg"><span class="swatch" style="background:var(--danger)"></span>Interruption</span></div></div>'+
      '<div class="selcap" id="hist_selcap"></div>'+
      '<div class="graph-wrap"><canvas id="hist_graph"></canvas><div class="hist-tip" id="hist_tip"></div></div></div>'+
    '<div class="lower">'+
      '<div class="hist-card panel-pad"><h2>Event timeline</h2><div class="timeline" id="hist_timeline"></div></div>'+
      '<div class="hist-card panel-pad"><h2>Firing notes</h2><div class="notes-ro">'+renderHistNotes(d.metadata)+'</div></div>'+
    '</div>';
  $("#hist_main").html(html);
  histBuildCurve(d);
  histRenderTimeline(d);
  histDrawGraph();
  histUpdateSelCap();
}

function renderHistNotes(m){
  m=m||{}; var o=m.outcome||{};
  var has = m.title || (m.tags&&m.tags.length) || (o.rating) || o.summary || (o.defects&&o.defects.length);
  if(!has) return '<div class="notes-empty">No notes recorded yet. (Adding titles, tags, ratings and photos comes next.)</div>';
  function nr(l,v){ return '<div class="nr"><label>'+l+'</label><div class="val">'+v+'</div></div>'; }
  function chips(a){ return '<div class="chips">'+a.map(function(x){return '<span class="chip">'+histEsc(x)+'</span>';}).join("")+'</div>'; }
  function stars(n){ var h=""; for(var i=1;i<=5;i++) h+='<span class="'+(i<=n?"on":"")+'">★</span>'; return '<span class="stars">'+h+'</span>'; }
  var html="";
  if(m.title) html+=nr("Title", histEsc(m.title));
  if(o.rating) html+=nr("Rating", stars(o.rating));
  if(m.tags&&m.tags.length) html+=nr("Tags", chips(m.tags));
  if(o.summary) html+=nr("What happened", histEsc(o.summary));
  if(o.defects&&o.defects.length) html+=nr("Defects", chips(o.defects));
  return html;
}

function histRenderTimeline(d){
  var tl=document.getElementById("hist_timeline"); tl.innerHTML="";
  (d.events||[]).forEach(function(e,i){
    var def=HIST_EV[e.type]||{c:"var(--muted)",i:"·",t:function(){return [e.type,""];}};
    var tt=def.t(e), title=tt[0], sub=tt[1];
    var row=document.createElement("div"); row.className="ev"; row.tabIndex=0;
    row.setAttribute("data-idx",i); row.setAttribute("data-col",histCssVar(def.c));
    row.innerHTML='<span class="ev-time tnum">'+histFmtClock(e.runtime||0)+'</span>'+
      '<span class="ev-ico" style="background:'+def.c+'">'+def.i+'</span>'+
      '<span class="ev-txt"><b>'+histEsc(title)+'</b>'+(sub?' <span class="ev-sub">— '+histEsc(sub)+'</span>':'')+'</span>';
    row.onclick=function(){ histSelectEvent(i); };
    row.onkeydown=function(ev){ if(ev.key==="Enter"||ev.key===" "){ ev.preventDefault(); histSelectEvent(i); } };
    tl.appendChild(row);
  });
}

function histSelectEvent(idx){
  histSel = (histSel===idx)?null:idx;
  $("#hist_timeline .ev").each(function(){
    var on = (+this.getAttribute("data-idx")===histSel);
    this.className = "ev"+(on?" sel":"");
    this.style.boxShadow = on ? ("inset 3px 0 0 "+this.getAttribute("data-col")) : "";
  });
  histUpdateSelCap(); histDrawGraph();
}
function histSelectFromGraph(idx){
  histSelectEvent(idx);
  if(histSel!=null){ var row=document.querySelector('#hist_timeline .ev[data-idx="'+histSel+'"]'); if(row) row.scrollIntoView({block:"nearest",behavior:"smooth"}); }
}
function histUpdateSelCap(){
  var cap=document.getElementById("hist_selcap"); if(!cap) return;
  if(histSel==null || !histCurve || !histCurve.events[histSel]){ cap.innerHTML='<span class="muted">Tip: select an event below to mark it on the graph</span>'; return; }
  var e=histCurve.events[histSel], def=HIST_EV[e.type]||{c:"var(--ink)",t:function(){return [e.type,""];}};
  var tt=def.t(e);
  cap.innerHTML='<span class="seldot" style="background:'+histCssVar(def.c)+'"></span><b>'+histEsc(tt[0])+'</b>'+
    (tt[1]?' <span class="muted">— '+histEsc(tt[1])+'</span>':'')+
    ' <span class="muted tnum">· '+histFmtClock(e.runtime||0)+' elapsed</span>'+
    '<button type="button" class="selx" onclick="histSelectEvent('+histSel+')">clear</button>';
}

function histBuildCurve(d){
  var act=(d.samples||[]).map(function(s){return [s.runtime,s.temperature];});
  var plan=((d.profile&&d.profile.data)||[]).map(function(p){return [p[0],p[1]];});
  var xmax=0,ymax=0;
  act.forEach(function(p){xmax=Math.max(xmax,p[0]); ymax=Math.max(ymax,p[1]);});
  plan.forEach(function(p){xmax=Math.max(xmax,p[0]); ymax=Math.max(ymax,p[1]);});
  ymax=Math.ceil((ymax*1.08)/100)*100||100;
  var bands=[], open=null;
  (d.events||[]).forEach(function(e){ if(e.type==="power_interruption") open=e.runtime;
    else if(e.type==="resumed"&&open!=null){ bands.push([open,e.runtime]); open=null; } });
  histCurve={act:act,plan:plan,xmax:xmax||1,ymax:ymax,events:d.events||[],bands:bands};
}

function histDrawGraph(){
  var cv=document.getElementById("hist_graph"); if(!cv||!histCurve) return;
  var dpr=window.devicePixelRatio||1, W=cv.clientWidth, H=cv.clientHeight;
  cv.width=W*dpr; cv.height=H*dpr;
  var g=cv.getContext("2d"); g.setTransform(dpr,0,0,dpr,0,0); g.clearRect(0,0,W,H);
  var m={l:46,r:14,t:18,b:40}, pw=W-m.l-m.r, ph=H-m.t-m.b;
  var X=function(x){return m.l+(x/histCurve.xmax)*pw;}, Y=function(y){return m.t+ph-(y/histCurve.ymax)*ph;};

  histCurve.bands.forEach(function(b){
    var x0=X(b[0]), x1=X(b[1]);
    g.fillStyle="rgba(255,59,48,.07)"; g.fillRect(x0,m.t,Math.max(2,x1-x0),ph);
    g.strokeStyle="rgba(255,59,48,.35)"; g.lineWidth=1; g.setLineDash([3,3]);
    g.beginPath(); g.moveTo(x0,m.t); g.lineTo(x0,m.t+ph); g.moveTo(x1,m.t); g.lineTo(x1,m.t+ph); g.stroke(); g.setLineDash([]);
  });

  g.fillStyle="#9aa3b2"; g.font="11px -apple-system,system-ui,sans-serif"; g.lineWidth=1;
  g.textAlign="right"; g.textBaseline="middle";
  var ystep=histNiceStep(histCurve.ymax,5);
  for(var v=0; v<=histCurve.ymax+1; v+=ystep){ var y=Y(v);
    g.strokeStyle="#e6e9ef"; g.globalAlpha=.8; g.beginPath(); g.moveTo(m.l,y); g.lineTo(W-m.r,y); g.stroke(); g.globalAlpha=1;
    g.fillText(v.toFixed(0), m.l-8, y); }
  g.textAlign="center"; g.textBaseline="top";
  var xstep=histNiceStep(histCurve.xmax,6);
  for(var xv=0; xv<=histCurve.xmax+1; xv+=xstep){ g.fillText(histFmtClock(xv), X(xv), m.t+ph+8); }
  g.textAlign="left"; g.fillText(histTU(), 6, m.t-2);

  if(histCurve.plan.length){
    g.strokeStyle="#0a84ff"; g.lineWidth=1.6; g.setLineDash([5,4]); g.beginPath();
    histCurve.plan.forEach(function(p,i){ var x=X(p[0]),y=Y(p[1]); i?g.lineTo(x,y):g.moveTo(x,y); });
    g.stroke(); g.setLineDash([]);
  }
  if(histCurve.act.length){
    var grad=g.createLinearGradient(0,m.t,0,m.t+ph);
    grad.addColorStop(0,"rgba(255,107,53,.22)"); grad.addColorStop(1,"rgba(255,107,53,0)");
    g.beginPath(); histCurve.act.forEach(function(p,i){ var x=X(p[0]),y=Y(p[1]); i?g.lineTo(x,y):g.moveTo(x,y); });
    var last=histCurve.act[histCurve.act.length-1], first=histCurve.act[0];
    g.lineTo(X(last[0]),Y(0)); g.lineTo(X(first[0]),Y(0)); g.closePath(); g.fillStyle=grad; g.fill();
    g.beginPath(); g.strokeStyle="#ff6b35"; g.lineWidth=2.2; g.lineJoin="round";
    histCurve.act.forEach(function(p,i){ var x=X(p[0]),y=Y(p[1]); i?g.lineTo(x,y):g.moveTo(x,y); });
    g.stroke();
    g.fillStyle="#ff6b35"; g.beginPath(); g.arc(X(last[0]),Y(last[1]),3.5,0,7); g.fill();
  }

  histPins=[];
  histCurve.events.forEach(function(e,idx){
    if(e.type==="segment_transition"||e.type==="resumed") return;
    var def=HIST_EV[e.type]; if(!def) return; var x=X(e.runtime||0);
    histPins.push({x:x,idx:idx});
    g.strokeStyle="rgba(17,21,28,.08)"; g.lineWidth=1; g.beginPath(); g.moveTo(x,m.t); g.lineTo(x,m.t+ph); g.stroke();
    g.fillStyle=histCssVar(def.c); g.beginPath(); g.arc(x,m.t-1,3.2,0,7); g.fill();
  });
  if(histSel!=null && histCurve.events[histSel]){
    var se=histCurve.events[histSel], sdef=HIST_EV[se.type]||{c:"var(--ink)"}, col=histCssVar(sdef.c), sx=X(se.runtime||0);
    g.strokeStyle=col; g.lineWidth=1.6; g.setLineDash([4,3]); g.beginPath(); g.moveTo(sx,m.t-4); g.lineTo(sx,m.t+ph); g.stroke(); g.setLineDash([]);
    g.fillStyle=col; g.beginPath(); g.arc(sx,m.t-4,4.5,0,7); g.fill();
    var yv=histInterp(histCurve.act, se.runtime||0);
    if(yv!=null){ var py=Y(yv); g.fillStyle="#fff"; g.strokeStyle=col; g.lineWidth=2.5; g.beginPath(); g.arc(sx,py,5.5,0,7); g.fill(); g.stroke(); }
  }
  histDrawCrosshair();
}

var histHoverX=null;
function histDrawCrosshair(){
  var cv=document.getElementById("hist_graph"); if(histHoverX==null||!histCurve||!cv||!histCurve.act.length) return;
  var g=cv.getContext("2d"), W=cv.clientWidth, H=cv.clientHeight;
  var m={l:46,r:14,t:18,b:40}, pw=W-m.l-m.r, ph=H-m.t-m.b;
  var xv=(histHoverX-m.l)/pw*histCurve.xmax;
  var lo=0,hi=histCurve.act.length-1;
  for(var i=0;i<histCurve.act.length;i++){ if(histCurve.act[i][0]>=xv){ hi=i; lo=Math.max(0,i-1); break; } }
  var p=(Math.abs(histCurve.act[lo][0]-xv)<Math.abs(histCurve.act[hi][0]-xv))?histCurve.act[lo]:histCurve.act[hi];
  var X=function(x){return m.l+(x/histCurve.xmax)*pw;}, Y=function(y){return m.t+ph-(y/histCurve.ymax)*ph;};
  var px=X(p[0]), py=Y(p[1]);
  g.strokeStyle="rgba(17,21,28,.22)"; g.lineWidth=1; g.setLineDash([2,3]); g.beginPath(); g.moveTo(px,m.t); g.lineTo(px,m.t+ph); g.stroke(); g.setLineDash([]);
  g.fillStyle="#fff"; g.strokeStyle="#ff6b35"; g.lineWidth=2; g.beginPath(); g.arc(px,py,4,0,7); g.fill(); g.stroke();
  var pv=histInterp(histCurve.plan,p[0]);
  var tip=document.getElementById("hist_tip");
  tip.style.opacity=1; tip.style.left=px+"px"; tip.style.top=py+"px";
  tip.innerHTML='<div class="tt-t">'+histFmtClock(p[0])+' elapsed</div>'+
    '<div class="tt-row"><span class="d" style="background:#ff6b35"></span>Actual <b style="margin-left:auto">'+Math.round(p[1])+'°</b></div>'+
    (pv!=null?'<div class="tt-row"><span class="d" style="background:#0a84ff"></span>Planned <b style="margin-left:auto">'+Math.round(pv)+'°</b></div>':'');
}
function histInterp(pts,x){
  if(!pts||!pts.length) return null;
  if(x<=pts[0][0]) return pts[0][1]; if(x>=pts[pts.length-1][0]) return pts[pts.length-1][1];
  for(var i=0;i<pts.length-1;i++){ if(pts[i+1][0]>=x){ var a=pts[i],b=pts[i+1]; return a[1]+(b[1]-a[1])*(x-a[0])/((b[0]-a[0])||1); } }
  return null;
}
function histNiceStep(max,n){ var raw=max/n, p=Math.pow(10,Math.floor(Math.log10(raw||1))), c=raw/p; var s=c<1.5?1:c<3?2:c<7?5:10; return s*p||1; }
function histCssVar(v){ if(v&&v.indexOf("var(")===0){ return getComputedStyle(document.documentElement).getPropertyValue(v.slice(4,-1)).trim()||"#999"; } return v; }

document.addEventListener("mousemove",function(e){
  var cv=document.getElementById("hist_graph"); if(!cv) return; var r=cv.getBoundingClientRect();
  if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom){ if(histHoverX!=null){ histHoverX=null; var t=document.getElementById("hist_tip"); if(t)t.style.opacity=0; histDrawGraph(); } return; }
  histHoverX=e.clientX-r.left; histDrawGraph();
});
document.addEventListener("click",function(e){
  var cv=document.getElementById("hist_graph"); if(!cv||!histPins.length) return; var r=cv.getBoundingClientRect();
  if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom) return;
  var x=e.clientX-r.left, best=null, bd=14;
  histPins.forEach(function(p){ var dd=Math.abs(p.x-x); if(dd<bd){ bd=dd; best=p.idx; } });
  if(best!=null) histSelectFromGraph(best);
});
var histRT; window.addEventListener("resize",function(){ if($("#history_view").is(":visible")){ clearTimeout(histRT); histRT=setTimeout(histDrawGraph,80); } });

/* deep-link: #history opens the history view (bookmarkable; the cloud proxy
   can link straight to it). showHistory/showLive keep the hash in sync. */
$(function(){
  if(location.hash==="#history") showHistory();
  window.addEventListener("hashchange",function(){
    if(location.hash==="#history"){ if(!$("#history_view").is(":visible")) showHistory(); }
    else if($("#history_view").is(":visible")) showLive();
  });
});
