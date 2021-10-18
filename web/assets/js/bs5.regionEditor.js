$(document).ready(function(e){
    var regionEditorWindow = $('#tab-regionEditor')
    var regionEditorForm = regionEditorWindow.find('form')
    var regionEditorRegionsList = $('#regions_list')
    var regionEditorRegionsPoints = $('#regions_points')
    var regionEditorRegionsCanvas = $('#regions_canvas')
    var regionStillImage = regionEditorWindow.find('.toggle-region-still-image');
    var regionEditorCanvasHolder = regionEditorWindow.find('.canvas_holder')
    var regionEditorMonitorsList = $('#region_editor_monitors')
    var regionEditorLiveView = $('#region_editor_live')
    var useRegionStillImage = false
    var getRegionEditorCanvas = function(){
        return regionEditorWindow.find('canvas')
    }
    var getRegionEditorNameField = function(){
        return regionEditorWindow.find('[name="name"]')
    }
    var getCurrentlySelectedMonitorId = function(){
        return regionEditorMonitorsList.val()
    }
    var getCurrentlySelectedRegionId = function(){
        return regionEditorRegionsList.val()
    }
    var regionViewerDetails = {}
    function createBlankCoorindateObject(name){
        var streamElement = regionEditorLiveView.find('iframe,img')
        var width = streamElement.width() || 200
        var height = streamElement.height() || 200
        return {
            name: name,
            sensitivity: 10,
            max_sensitivity: '',
            threshold: 1,
            color_threshold: 9,
            points: [
                [0, 0],
                [0, height],
                [width, height],
                [width, 0]
            ]
        }
    }
    var loadRegionEditor = function(monitor){
        var theCanvas = getRegionEditorCanvas()
        var monitorDetails = Object.assign({},monitor.details)
        var imageWidth = !isNaN(monitorDetails.detector_scale_x) ? parseInt(monitorDetails.detector_scale_x) : 640
        var imageHeight = !isNaN(monitorDetails.detector_scale_y) ? parseInt(monitorDetails.detector_scale_y) : 480
        monitorDetails.cords = monitorDetails.cords ? safeJsonParse(monitorDetails.cords) || {} : {}
        getRegionEditorCanvas()
            .attr('width',imageWidth)
            .attr('height',imageHeight);
        regionEditorCanvasHolder.css({
            width: imageWidth,
            height: imageHeight
        });
        if(Object.keys(monitorDetails.cords).length === 0){
            monitorDetails.cords = {}
            monitorDetails.cords[generateId(5)] = createBlankCoorindateObject(lang['Region Name'])
        }
        regionViewerDetails = monitorDetails;
        initiateRegionList()
    }
    var drawPointsTable = function(){
        var currentRegionId = getCurrentlySelectedRegionId()
        var value = regionEditorRegionsCanvas.val().replace(/(,[^,]*),/g, '$1;').split(';');
        var newArray = [];
        $.each(value,function(n,v){
            v = v.split(',')
            if(v[1]){
                newArray.push([v[0],v[1]])
            }
        })
        regionViewerDetails.cords[currentRegionId].points = newArray
        regionEditorRegionsPoints.empty()
        $.each(regionViewerDetails.cords[currentRegionId].points,function(n,v){
            if(isNaN(v[0])){v[0] = 20}
            if(isNaN(v[1])){v[1] = 20}
            regionEditorRegionsPoints.append(`<tr points="${n}">
    <td>
        <input class="form-control" placeholder="X" point="x" value="${v[0]}">
    </td>
    <td>
        <input class="form-control" placeholder="Y" point="y" value="${v[1]}">
    </td>
    <td class="text-right"><a class="badge delete btn btn-sm btn-danger text-white"><i class="fa fa-trash-o"></i></a></td>
</tr>`)
        })
    }
    function saveCoords(coorindates){
        var monitorId = getCurrentlySelectedMonitorId()
        var monitorConfig = Object.assign({},loadedMonitors[monitorId])
        var regionCoordinates = Object.assign({},coorindates || regionViewerDetails.cords instanceof Object ? regionViewerDetails.cords : safeJsonParse(regionViewerDetails.cords) || {});
        monitorConfig.details.cords = JSON.stringify(regionCoordinates)
        monitorConfig.details = JSON.stringify(monitorConfig.details)
        $.post(getApiPrefix(`configureMonitor`)+ '/' + monitorId,{
            data: JSON.stringify(monitorConfig)
        },function(d){
            debugLog(d)
            if(d.ok){

            }
        })
    }
    var initiateRegionList = function(){
        regionEditorRegionsList.empty()
        regionEditorRegionsPoints.empty()
        $.each(regionViewerDetails.cords,function(regionId,region){
            if(region && region.name){
                regionEditorRegionsList.append('<option value="' + regionId + '">' + region.name + '</option>')
            }
        });
        regionEditorRegionsList.change();
    }
    var initLiveStream = function(){
        var monitorId = getCurrentlySelectedMonitorId()
        var apiPoint = 'embed'
        var liveElement = regionEditorLiveView.find('iframe,img')
        regionEditorLiveView.find('iframe,img').attr('src','').hide()
        if(useRegionStillImage){
            apiPoint = 'jpeg'
        }else{
            apiPoint = 'embed'
        }
        var apiUrl = `${getApiPrefix(apiPoint)}/${monitorId}`
        if(apiPoint === 'embed'){
            apiUrl += '/fullscreen|jquery|relative'
        }else{
            apiUrl += '/s.jpg'
        }
        if(liveElement.attr('src') !== apiUrl){
            liveElement.attr('src',apiUrl).show()
        }
        liveElement.attr('width',regionViewerDetails.detector_scale_x)
        liveElement.attr('height',regionViewerDetails.detector_scale_y)
    }
    var initCanvas = function(dontReloadStream){
        var newArray = [];
        var regionEditorRegionsListValue = regionEditorRegionsList.val();
        if(!regionEditorRegionsListValue){
            regionEditorForm.find('[name="name"]').val('')
            regionEditorForm.find('[name="sensitivity"]').val('')
            regionEditorForm.find('[name="max_sensitivity"]').val('')
            regionEditorForm.find('[name="threshold"]').val('')
            regionEditorForm.find('[name="color_threshold"]').val('')
            regionEditorRegionsPoints.empty()
        }else{
            var cord = regionViewerDetails.cords[regionEditorRegionsListValue];
            if(!cord.points){
                cord.points = [
                    [0,0],
                    [0,100],
                    [100,0]
                ]
            }
            $.each(cord.points,function(n,v){
                newArray = newArray.concat(...v)
            })
            if(isNaN(cord.sensitivity)){
                cord.sensitivity = regionViewerDetails.detector_sensitivity
            }
            regionEditorForm.find('[name="name"]').val(cord.name || regionEditorRegionsListValue)
            regionEditorWindow.find('.cord_name').text(cord.name || regionEditorRegionsListValue)
            regionEditorForm.find('[name="sensitivity"]').val(cord.sensitivity)
            regionEditorForm.find('[name="max_sensitivity"]').val(cord.max_sensitivity)
            regionEditorForm.find('[name="threshold"]').val(cord.threshold)
            regionEditorForm.find('[name="color_threshold"]').val(cord.color_threshold)
            regionEditorWindow.find('.canvas_holder canvas').remove()
            if(!dontReloadStream)initLiveStream();
            regionEditorRegionsCanvas.val(newArray.join(','))
            regionEditorRegionsCanvas.canvasAreaDraw({
                imageUrl: placeholder.getData(placeholder.plcimg({
                    bgcolor: 'transparent',
                    text: ' ',
                    size: regionViewerDetails.detector_scale_x+'x'+regionViewerDetails.detector_scale_y
                }))
            })
            drawPointsTable()
        }
    }
    function getRegionStillImageSwitch(){
        var dashboardSwitches = dashboardOptions().switches || {}
        return dashboardSwitches.regionStillImage || '0'
    }
    regionEditorRegionsList.change(function(e){
        initCanvas(true);
    })
    regionEditorWindow.on('change','[name]',function(){
        var currentRegionId = getCurrentlySelectedRegionId()
        var el = $(this)
        var val = el.val()
        var key = el.attr('name')
        regionViewerDetails.cords[currentRegionId][key] = val
    })
    regionEditorWindow.on('change','[point]',function(e){
        var currentRegionId = getCurrentlySelectedRegionId()
        var points = [];
        $('[points]').each(function(n,v){
            var el = $(this)
            var pointValueX = el.find('[point="x"]').val()
            if(pointValueX){
                points.push([
                    pointValueX,
                    el.find('[point="y"]').val()
                ])
            }
        })
        regionViewerDetails.cords[currentRegionId].points = points;
        initCanvas()
    })
    regionEditorWindow.find('.erase').click(function(e){
        var currentRegionId = getCurrentlySelectedRegionId()
        var newCoordinates = []
        $.each(regionViewerDetails.cords,function(n,points){
            if(points && points !== regionViewerDetails.cords[currentRegionId]){
                newCoordinates.push(points)
            }
        })
        regionViewerDetails.cords = newCoordinates.concat([])
        if(Object.keys(regionViewerDetails.cords).length > 0){
            initiateRegionList();
        }else{
            regionEditorForm.find('input').prop('disabled',true)
            regionEditorRegionsPoints.empty()
            regionEditorRegionsList.find('[value="'+currentRegionId+'"]').remove()
            // saveCoords([])
        }
    })
    regionEditorWindow.on('changed','#regions_canvas',function(e){
        drawPointsTable()
        // saveCoords()
    })
    regionEditorForm.submit(function(e){
        e.preventDefault()
        saveCoords()
        return false;
    })
    regionEditorRegionsPoints
    .on('click','.delete',function(e){
        e.stopPropagation()
        var elParent = $(this).parents('tr')
        var points = elParent.attr('points')
        delete(regionViewerDetails.cords[regionEditorRegionsList.val()].points[points])
        // saveCoords()
        elParent.remove()
        regionEditorRegionsList.change()
        return false;
    })
    regionEditorWindow.on('click','.add',function(e){
        e.stopPropagation()
        regionEditorForm.find('input').prop('disabled',false)
        var randomId = generateId(5);
        var newCoordinates = {}
        $.each(regionViewerDetails.cords,function(n,v){
            if(v && v !== null && v !== 'null'){
                newCoordinates[n] = v;
            }
        })
        regionViewerDetails.cords = newCoordinates
        regionViewerDetails.cords[randomId] = createBlankCoorindateObject(lang['Region Name'])
        regionEditorRegionsList.append(`<option value="${randomId}">${lang['Region Name']}</option>`)
        regionEditorRegionsList.val(randomId)
        regionEditorRegionsList.change()
        return false;
    })
    regionStillImage.click(function(e){
        var dashboardSwitches = dashboardOptions().switches || {}
        if(useRegionStillImage){
            dashboardSwitches.regionStillImage = 1
        }else{
            dashboardSwitches.regionStillImage = "0"
        }
        dashboardOptions('switches',dashboardSwitches)
        useRegionStillImage = !useRegionStillImage
        initLiveStream()
    })
    $('body')
    .on('click','.open-region-editor',function(e){
        var monitorId = getMonitorIdFromElement(this)
        var monitor = loadedMonitors[monitorId]
        openTab(`regionEditor`,{},null)
        loadRegionEditor(monitor)
        initLiveStream()
    });
    regionEditorMonitorsList.change(function(){
        var monitorId = $(this).val()
        var monitor = loadedMonitors[monitorId]
        if(monitor)loadRegionEditor(monitor)
    })
    addOnTabOpen('regionEditor', function () {
        useRegionStillImage = getRegionStillImageSwitch() === 1;
        if(!regionEditorMonitorsList.val()){
            drawMonitorListToSelector(regionEditorMonitorsList,true)
        }
    })
    addOnTabReopen('regionEditor', function () {
        initLiveStream()
        var theSelected = `${regionEditorMonitorsList.val()}`
        drawMonitorListToSelector(regionEditorMonitorsList)
        regionEditorMonitorsList.val(theSelected)
    })
    drawSubMenuItems('regionEditor',definitions['Region Editor'])
})
